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
  type MessageReaction,
  type User,
} from "discord.js";
import { type FaqConfig, loadConfig } from "./config.js";
import { type CompiledTrigger, compileTriggers, findMatch } from "./matcher.js";
import { watch } from "node:fs";
import { resolveTarget } from "./targets.js";
import { decodePobCode, looksLikePobCode, uploadToPobbin } from "./pob.js";
import { extractPoeLinks, fetchPobCodeFromUrl, type PoeLink } from "./poeLinks.js";
import { parseBuildFile } from "./buildFile.js";
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
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
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

  const { features, commandChannels } = config.settings;
  const featureOn = interaction.commandName === "faq" ? features.faq : features.pobCodes;
  if (!features.commands || !featureOn) {
    await interaction.reply({ content: "This command is turned off.", ephemeral: true });
    return;
  }

  if (commandChannels.length > 0 && interaction.channelId && !commandChannels.includes(interaction.channelId)) {
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
    // Validate the code before uploading it
    await decodePobCode(code);
  } catch (error) {
    await reply({ content: `❌ That isn't a valid PoB code: ${(error as Error).message}` });
    return;
  }

  const url = await uploadToPobbin(code);
  if (!url) {
    await reply({ content: "❌ Could not upload the build to pobb.in. Please try again." });
    return;
  }

  await reply({ content: url });
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
    const fetched = await fetchPobCodeFromUrl(link);
    if (!fetched) continue; // Stay silent for links we can't turn into a code

    const url = await uploadToPobbin(fetched.code);
    if (url) {
      await message.reply({ content: url, allowedMentions: { repliedUser: false } });
      return;
    }
  }
}

async function handlePobCodeInMessage(message: Message, code: string): Promise<void> {
  try {
    // Validate before uploading so random base64 isn't sent to pobb.in
    await decodePobCode(code);
  } catch {
    return; // Not a valid PoB code — ignore silently
  }

  const url = await uploadToPobbin(code);
  if (url) {
    await message.reply({ content: url, allowedMentions: { repliedUser: false } });
  }
}

/** Check attachments: .txt/.pob hold PoB codes, .build holds GGG build JSON. */
async function extractPobCodeFromAttachments(message: Message): Promise<string | null> {
  if (!message.attachments || message.attachments.size === 0) return null;

  for (const attachment of message.attachments.values()) {
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

async function handleBuildFile(message: Message, attachment: { url: string }): Promise<void> {
  try {
    const response = await fetch(attachment.url);
    if (!response.ok) return;
    const summary = parseBuildFile(await response.text());
    if (!summary) return; // Not a GGG build file — stay silent

    const lines = [];
    if (summary.name) lines.push(`**${summary.name}**`);
    const identity = [summary.ascendancy, summary.characterClass].filter(Boolean).join(" — ");
    if (identity) lines.push(identity);
    if (summary.level !== undefined) lines.push(`Level ${summary.level}`);
    if (summary.passiveCount > 0) lines.push(`${summary.passiveCount} passive points`);
    if (summary.skills.length > 0) lines.push(`Skills: ${summary.skills.join(", ")}`);
    if (summary.items.length > 0) lines.push(`Gear: ${summary.items.join(", ")}`);

    if (lines.length === 0) return;
    await message.reply({
      content: lines.join("\n"),
      allowedMentions: { repliedUser: false },
    });
  } catch {
    // Ignore fetch/parse failures
  }
}

async function handleMessage(message: Message): Promise<void> {
  if (!message.guild) return;
  if (config.settings.ignoreBots && message.author.bot) return;

  const { features } = config.settings;
  const inChannel = (list: string[]) => list.length === 0 || list.includes(message.channelId);

  if (features.pobCodes && inChannel(config.settings.codeChannels)) {
    // .build attachments (GGG Build Planner JSON)
    for (const attachment of message.attachments.values()) {
      if (attachment.name?.toLowerCase().endsWith(".build")) {
        await handleBuildFile(message, attachment);
        return;
      }
    }

    const pobCodeFromAttachment = await extractPobCodeFromAttachments(message);
    if (pobCodeFromAttachment) {
      await handlePobCodeInMessage(message, pobCodeFromAttachment);
      return;
    }

    if (message.content) {
      const pobCode = extractPobCode(message.content);
      if (pobCode) {
        await handlePobCodeInMessage(message, pobCode);
        return;
      }
    }
  }

  if (features.poeLinks && message.content && inChannel(config.settings.linkChannels)) {
    const poeLinks = extractPoeLinks(message.content);
    if (poeLinks.length > 0) {
      await handlePoeLinksInMessage(message, poeLinks);
      return;
    }
  }

  if (!features.faq || !message.content || !inChannel(config.settings.messageChannels)) return;

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

const CONFIG_FILE = process.env.CONFIG_PATH || "config/faq.json";

async function reloadConfig(): Promise<void> {
  try {
    const next = await loadConfig();
    config = next;
    triggers = compileTriggers(next.entries);
    console.log(`[faq] reloaded ${CONFIG_FILE}: ${next.entries.length} entries, ${triggers.length} triggers`);
  } catch (error) {
    console.error("[faq] config reload failed, keeping the previous config:", (error as Error).message);
  }
}

function watchConfig(): void {
  let timer: NodeJS.Timeout | undefined;
  watch(CONFIG_FILE, () => {
    clearTimeout(timer);
    timer = setTimeout(() => void reloadConfig(), 300);
  });
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

/** Apply or remove a role when someone reacts to a bot-created reaction-role post. */
async function handleReaction(
  reaction: MessageReaction | { partial: true; fetch(): Promise<MessageReaction>; emoji: { id: string | null; name: string | null }; message: unknown },
  user: User | { id: string; tag?: string | null; bot?: boolean | null },
  action: "add" | "remove",
): Promise<void> {
  if (user.bot) return;
  let fullReaction: MessageReaction;
  if (reaction.partial) {
    try { fullReaction = await reaction.fetch(); } catch { return; }
  } else {
    fullReaction = reaction as MessageReaction;
  }

  const message = fullReaction.message;
  if (message.partial) {
    try { await message.fetch(); } catch { return; }
  }
  if (!message.guild) return;

  const post = (config.reactionPosts ?? []).find((p) => p.messageId === message.id);
  if (!post) return;

  const emojiKey = fullReaction.emoji.id
    ? `<:${fullReaction.emoji.name}:${fullReaction.emoji.id}>`
    : fullReaction.emoji.name;
  if (!emojiKey) return;
  const roleId = post.roles[emojiKey];
  if (!roleId) return;

  let member;
  try {
    member = await message.guild.members.fetch(user.id);
  } catch {
    return;
  }

  const role = message.guild.roles.cache.get(roleId);
  if (!role) {
    console.error(`[faq] reaction role ${roleId} not found in guild ${message.guild.id}`);
    return;
  }

  try {
    if (action === "add") {
      await member.roles.add(role, "Reaction role");
    } else {
      await member.roles.remove(role, "Reaction role removed");
    }
  } catch (error) {
    console.error(`[faq] failed to ${action} role ${role.name} for ${user.tag}:`, (error as Error).message);
  }
}

client.on(Events.MessageReactionAdd, (reaction, user) => {
  void handleReaction(reaction, user, "add").catch((error) => {
    console.error("[faq] error handling reaction add:", error);
  });
});

client.on(Events.MessageReactionRemove, (reaction, user) => {
  void handleReaction(reaction, user, "remove").catch((error) => {
    console.error("[faq] error handling reaction remove:", error);
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
  watchConfig();
}

void main().catch((error) => {
  if (error instanceof Error && /privileged|intent/i.test(error.message)) printIntentHelp();
  console.error("[faq] failed to start:", error);
  process.exit(1);
});
