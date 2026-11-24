import "dotenv/config";
import {
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  type Interaction,
  type Message,
} from "discord.js";
import { type FaqConfig, loadConfig } from "./config.js";
import { type CompiledTrigger, compileTriggers, findMatch } from "./matcher.js";
import { resolveTarget } from "./targets.js";
import { decodePobCode, looksLikePobCode, parsePobSummary, type PobSummary } from "./pob.js";
import { extractPoeLinks, fetchPobCodeFromUrl, linkTypeName, type PoeLink } from "./poeLinks.js";
import "./admin.js"; // Start admin web interface

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return value;
}

const token = requireEnv("DISCORD_TOKEN");

// MessageContent is a privileged intent: it must also be switched on in the
// Developer Portal, otherwise the gateway closes with 4014 on connect.
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// Assigned during startup, before the gateway connects, so every handler below
// can read them without null checks.
let config!: FaqConfig;
let triggers!: CompiledTrigger[];

const cooldowns = new Map<string, number>();

function printIntentHelp(): void {
  console.error(`
The gateway refused a privileged intent. Enable it:

  1. https://discord.com/developers/applications -> your application
  2. Bot -> Privileged Gateway Intents
  3. Switch on "Message Content Intent"
  4. Restart the bot

Without it the bot connects, but every message arrives with empty content,
so nothing will ever match.
`);
}

const FAQ_COMMAND = new SlashCommandBuilder()
  .setName("faq")
  .setDescription("Look up a frequently asked question")
  .addStringOption((option) =>
    option
      .setName("query")
      .setDescription("Your question — leave blank to list every topic"),
  )
  .toJSON();

const POB_COMMAND = new SlashCommandBuilder()
  .setName("pob")
  .setDescription("Decode a Path of Building share code and show build info")
  .addStringOption((option) =>
    option
      .setName("code")
      .setDescription("The PoB share code (paste the long string from PoB's Share button)")
      .setRequired(true)
      .setMaxLength(4000),
  )
  .toJSON();

const COMMANDS = [FAQ_COMMAND, POB_COMMAND];

async function registerCommands(): Promise<void> {
  // `||`, not `??`: .env files often contain `CLIENT_ID=` (empty string),
  // which ?? would happily pass straight through to the API.
  const clientId = process.env.CLIENT_ID || client.user?.id;
  if (!clientId) {
    console.warn("[faq] could not determine the application id; skipping slash command registration.");
    return;
  }

  const guildId = process.env.GUILD_ID || undefined;
  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);

  await new REST().setToken(token).put(route, { body: COMMANDS });
  console.log(
    `[faq] registered /faq ${
      guildId ? `to guild ${guildId} (appears instantly)` : "globally (may take up to an hour)"
    }`,
  );
}

/** "#5865F2" -> 0x5865F2. Config validation guarantees the format. */
function toColor(hex: string): number {
  return Number.parseInt(hex.slice(1), 16);
}

function buildEmbed(entry: FaqConfig["entries"][number], url: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(toColor(entry.color ?? config.settings.embedColor))
    .setTitle(entry.label)
    .setDescription(entry.message)
    .setURL(url);
}

/** Shared shape so one helper can reply to both messages and interactions. */
interface FaqReplyPayload {
  content?: string;
  embeds?: EmbedBuilder[];
  allowedMentions?: { repliedUser?: boolean };
}
type FaqReply = (payload: FaqReplyPayload) => Promise<unknown>;

async function replyWithFaq(
  reply: FaqReply,
  match: { entry: FaqConfig["entries"][number]; trigger: string },
  guildId: string | null,
): Promise<void> {
  const { entry, trigger } = match;
  const allowedMentions = { repliedUser: config.settings.replyMentions };

  let url: string | null = null;
  let failure: unknown = null;
  try {
    if (!guildId) throw new Error("cannot resolve a target outside a guild");
    url = await resolveTarget(client, guildId, entry.target);
  } catch (error) {
    failure = error;
  }

  if (url === null) {
    // Answer anyway rather than leaving the asker hanging, but log loudly —
    // a broken target is a config problem, not something to hide.
    console.error(`[faq] entry "${entry.id}" could not resolve its target:`, failure);
    await reply({ content: entry.message, allowedMentions });
    return;
  }

  const embed = buildEmbed(entry, url).setFooter({ text: `Matched "${trigger}"` });
  await reply({ embeds: [embed], allowedMentions });
}

async function handleCommand(interaction: Interaction): Promise<void> {
  if (!interaction.isChatInputCommand()) return;

  // Check command channel allowlist
  const cmdChannels = config.settings.commandChannels;
  if (cmdChannels.length > 0 && interaction.channelId && !cmdChannels.includes(interaction.channelId)) {
    await interaction.reply({ content: "Commands are not enabled in this channel.", ephemeral: true });
    return;
  }

  if (interaction.commandName === "faq") {
    await handleFaqCommand(interaction);
    return;
  }

  if (interaction.commandName === "pob") {
    await handlePobCommand(interaction);
    return;
  }
}

async function handleFaqCommand(interaction: Interaction): Promise<void> {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "faq") return;

  // Acknowledge straight away: resolving a pin is a REST call, and Discord
  // gives us only 3 seconds before the interaction times out.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const reply: FaqReply = (payload) => interaction.editReply(payload);

  const query = interaction.options.getString("query");

  if (!query) {
    const topics = config.entries.map((entry) => `\`${entry.id}\` — ${entry.label}`).join("\n");
    await reply({
      embeds: [
        new EmbedBuilder()
          .setColor(toColor(config.settings.embedColor))
          .setTitle("FAQ topics")
          .setDescription(topics || "No entries configured yet.")
          .setFooter({ text: "Use /faq query:<your question> to test a phrase" }),
      ],
    });
    return;
  }

  const match = findMatch(triggers, query);
  if (!match) {
    await reply({ content: `Nothing in the FAQ matches **${query}**.` });
    return;
  }

  await replyWithFaq(reply, match, interaction.guildId);
}

async function handlePobCommand(interaction: Interaction): Promise<void> {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "pob") return;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const reply: FaqReply = (payload) => interaction.editReply(payload);

  const code = interaction.options.getString("code", true).trim();

  try {
    const xml = await decodePobCode(code);
    const summary = parsePobSummary(xml);

    const fields: { name: string; value: string; inline: boolean }[] = [
      { name: "Game", value: summary.game, inline: true },
    ];
    if (summary.level) {
      fields.push({ name: "Level", value: String(summary.level), inline: true });
    }
    if (summary.skills.length > 1) {
      fields.push({ name: "Skills", value: summary.skills.join(", "), inline: false });
    }

    const embed = new EmbedBuilder()
      .setColor(toColor(config.settings.embedColor))
      .setTitle(`${summary.className ?? "Unknown"}${summary.ascendancy ? ` — ${summary.ascendancy}` : ""}`)
      .setDescription(summary.mainSkill ? `**Main skill:** ${summary.mainSkill}` : "Build decoded successfully")
      .addFields(fields);

    if (summary.notes) {
      embed.addFields({ name: "Notes", value: summary.notes.slice(0, 500), inline: false });
    }

    embed.setFooter({ text: "Decoded from a Path of Building share code" });
    await reply({ embeds: [embed] });
  } catch (error) {
    await reply({
      content: `❌ Could not decode the PoB code: ${(error as Error).message}\n\n` +
        "Make sure you copied the full code from PoB's **Share → Copy build code** button. " +
        "The code is a long string of letters and numbers.\n\n" +
        "💡 If the code is too long for this command, just paste it as a regular message or attach it as a .txt file — the bot will auto-detect it.",
    });
  }
}

/** Extract a PoB share code from a message, if present. */
function extractPobCode(text: string): string | null {
  // PoB codes are typically posted on their own line or after a label
  const lines = text.split(/\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length >= 50 && looksLikePobCode(trimmed)) {
      return trimmed;
    }
  }
  // Also check if the whole message is a PoB code
  const trimmed = text.trim();
  if (trimmed.length >= 50 && looksLikePobCode(trimmed)) {
    return trimmed;
  }
  return null;
}

async function handlePoeLinksInMessage(message: Message, links: PoeLink[]): Promise<void> {
  for (const link of links) {
    // Try to fetch and decode a PoB code from the link
    const xml = await fetchPobCodeFromUrl(link);
    if (xml) {
      try {
        const summary = parsePobSummary(xml);
        const embed = new EmbedBuilder()
          .setColor(toColor(config.settings.embedColor))
          .setTitle(`${summary.className ?? "PoE Build"}${summary.ascendancy ? ` — ${summary.ascendancy}` : ""}`)
          .setDescription(summary.mainSkill ? `**Main skill:** ${summary.mainSkill}` : "Build decoded")
          .addFields(
            { name: "Game", value: summary.game, inline: true },
            ...(summary.level ? [{ name: "Level", value: String(summary.level), inline: true }] : []),
            ...(summary.skills.length > 1
              ? [{ name: "Skills", value: summary.skills.slice(0, 5).join(", "), inline: false }]
              : []),
          )
          .setFooter({ text: `Decoded from ${linkTypeName(link.type)} link` });

        if (summary.notes) {
          embed.addFields({ name: "Notes", value: summary.notes.slice(0, 300), inline: false });
        }

        await message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
        return;
      } catch {
        // Fall through to helpful message
      }
    }

    // If we couldn't decode, respond with a helpful message for known sites
    const name = linkTypeName(link.type);
    let helpText = "";
    switch (link.type) {
      case "maxroll":
        helpText = "Maxroll build guides contain PoB codes. To decode, copy the PoB code from the guide and paste it here, or use `/pob <code>`.";
        break;
      case "pob.codes":
        helpText = "pob.codes is a PoB viewer. To decode the build, copy the PoB share code from pob.codes and paste it here, or use `/pob <code>`.";
        break;
      case "poe.ninja":
        helpText = "poe.ninja shows builds but doesn't expose raw PoB codes directly. You can usually find the PoB code on the build's page or ask the author.";
        break;
      default:
        helpText = `I detected a ${name} link but couldn't extract a PoB code from it. Try pasting the raw PoB code directly.`;
    }

    if (helpText) {
      await message.reply({ content: helpText, allowedMentions: { repliedUser: false } });
      return;
    }
  }
}

async function handlePobCodeInMessage(message: Message, code: string): Promise<void> {
  try {
    const xml = await decodePobCode(code);
    const summary = parsePobSummary(xml);

    const embed = new EmbedBuilder()
      .setColor(toColor(config.settings.embedColor))
      .setTitle(`${summary.className ?? "PoE Build"}${summary.ascendancy ? ` — ${summary.ascendancy}` : ""}`)
      .setDescription(summary.mainSkill ? `**Main skill:** ${summary.mainSkill}` : "Build decoded")
      .addFields(
        { name: "Game", value: summary.game, inline: true },
        ...(summary.level ? [{ name: "Level", value: String(summary.level), inline: true }] : []),
        ...(summary.skills.length > 1
          ? [{ name: "Skills", value: summary.skills.slice(0, 5).join(", "), inline: false }]
          : []),
      )
      .setFooter({ text: "Auto-detected from a Path of Building share code" });

    await message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
  } catch {
    // Not a valid PoB code — ignore silently
  }
}

/** Check message attachments for PoB codes (Discord converts long pastes to .txt files). */
async function extractPobCodeFromAttachments(message: Message): Promise<string | null> {
  if (!message.attachments || message.attachments.size === 0) return null;

  for (const attachment of message.attachments.values()) {
    // Only check text files
    const name = attachment.name?.toLowerCase() ?? "";
    if (!name.endsWith(".txt") && !name.endsWith(".pob") && !attachment.contentType?.startsWith("text/")) {
      continue;
    }

    try {
      const response = await fetch(attachment.url);
      if (!response.ok) continue;
      const content = await response.text();
      const trimmed = content.trim();
      if (trimmed.length >= 50 && looksLikePobCode(trimmed)) {
        return trimmed;
      }
    } catch {
      // Ignore fetch errors
    }
  }

  return null;
}

async function handleMessage(message: Message): Promise<void> {
  if (!message.guild) return;
  if (config.settings.ignoreBots && message.author.bot) return;

  const allowlist = config.settings.messageChannels;
  if (allowlist.length > 0 && !allowlist.includes(message.channelId)) {
    // Still allow PoB code detection and PoE link handling in non-allowlisted channels
    // if codeChannels or commandChannels include this channel
  }

  // Check message attachments for PoB codes (Discord converts long pastes to .txt files)
  const codeChannels = config.settings.codeChannels;
  const codeAllowed = codeChannels.length === 0 || codeChannels.includes(message.channelId);
  if (codeAllowed) {
    const pobCodeFromAttachment = await extractPobCodeFromAttachments(message);
    if (pobCodeFromAttachment) {
      await handlePobCodeInMessage(message, pobCodeFromAttachment);
      return;
    }
  }

  if (message.content) {
    if (codeAllowed) {
      const pobCode = extractPobCode(message.content);
      if (pobCode) {
        await handlePobCodeInMessage(message, pobCode);
        return;
      }

      const poeLinks = extractPoeLinks(message.content);
      if (poeLinks.length > 0) {
        await handlePoeLinksInMessage(message, poeLinks);
        return;
      }
    }

    // FAQ keyword triggers — only in messageChannels (or all if empty)
    const msgChannels = config.settings.messageChannels;
    if (msgChannels.length > 0 && !msgChannels.includes(message.channelId)) {
      return;
    }

    const match = findMatch(triggers, message.content);
    if (!match) return;
    if (match.entry.channelIds && !match.entry.channelIds.includes(message.channelId)) return;

    const now = Date.now();
    if (now - (cooldowns.get(message.author.id) ?? 0) < config.settings.cooldownSeconds * 1000) {
      return;
    }
    cooldowns.set(message.author.id, now);

    const reply: FaqReply = (payload) => message.reply(payload);
    await replyWithFaq(reply, match, message.guild.id);
  }
}

client.once(Events.ClientReady, (ready) => {
  console.log(`[faq] logged in as ${ready.user.tag}`);
  console.log(
    `[faq] ${config.entries.length} entries, ${triggers.length} triggers, ` +
      `cooldown ${config.settings.cooldownSeconds}s, ` +
      `msg channels: ${config.settings.messageChannels.length > 0 ? config.settings.messageChannels.length : "all"}, ` +
      `code channels: ${config.settings.codeChannels.length > 0 ? config.settings.codeChannels.length : "all"}, ` +
      `cmd channels: ${config.settings.commandChannels.length > 0 ? config.settings.commandChannels.length : "all"}`,
  );

  // Set the bot's presence/activity
  client.user?.setActivity("Arcane Surge FF combo is Cheap");

  void registerCommands().catch((error) => {
    console.error("[faq] failed to register slash commands:", error);
  });
});

client.on(Events.MessageCreate, (message) => {
  void handleMessage(message).catch((error) => {
    console.error("[faq] error while handling a message:", error);
  });
});

client.on(Events.InteractionCreate, (interaction) => {
  void handleCommand(interaction).catch((error) => {
    console.error("[faq] error while handling an interaction:", error);
  });
});

client.on(Events.ShardError, (error, shardId) => {
  console.error(`[faq] shard ${shardId} error:`, error);
  if (/privileged|intent/i.test(String((error as Error)?.message ?? error))) printIntentHelp();
});

client.on(Events.Warn, (message) => console.warn("[faq]", message));
client.on(Events.Debug, (message) => {
  if (process.env.DEBUG) console.debug("[faq]", message);
});

process.on("unhandledRejection", (reason) => {
  console.error("[faq] unhandled rejection:", reason);
});

async function main(): Promise<void> {
  config = await loadConfig();
  triggers = compileTriggers(config.entries);
  console.log(
    `[faq] loaded ${process.env.CONFIG_PATH ?? "config/faq.json"} with ` +
      `${config.entries.length} entries`,
  );
  await client.login(token);
}

void main().catch((error) => {
  if (error instanceof Error && /privileged|intent/i.test(error.message)) printIntentHelp();
  console.error("[faq] failed to start:", error);
  process.exit(1);
});
