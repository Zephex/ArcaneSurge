import "dotenv/config";
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  REST,
  Routes,
} from "discord.js";
import { fetchPins } from "./targets.js";

/**
 * Small helpers for filling in config/faq.json.
 *
 *   npm run ids                 list guilds, channels and active threads
 *   npm run pins -- <channelId> list a channel's pins with their IDs
 */
function usage(): never {
  console.log(`
Usage:
  npm run ids                 list guilds, channels and active threads
  npm run pins -- <channelId> list a channel's pinned messages
`);
  process.exit(1);
}

function typeName(type: ChannelType): string {
  return (ChannelType as unknown as Record<number, string>)[type] ?? String(type);
}

/** The guild channel union includes thread types, which have no position. */
function channelPosition(channel: { position?: number }): number {
  return channel.position ?? 0;
}

async function listIds(): Promise<void> {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(process.env.DISCORD_TOKEN);

  const rest = new REST().setToken(process.env.DISCORD_TOKEN as string);

  if (client.guilds.cache.size === 0) {
    console.log("The bot is not in any guilds yet — invite it first.");
  }

  for (const guild of client.guilds.cache.values()) {
    console.log(`\n${guild.name}   guildId=${guild.id}`);

    const channels = [...guild.channels.cache.values()]
      .filter((channel) => !channel.isThread()) // threads are listed separately below
      .sort((a, b) => channelPosition(a) - channelPosition(b));
    for (const channel of channels) {
      console.log(`  ${typeName(channel.type).padEnd(18)} ${channel.name ?? "(unknown)"}  ${channel.id}`);
    }

    try {
      const active = (await rest.get(Routes.guildActiveThreads(guild.id))) as {
        threads: Array<{ id: string; name: string; parent_id: string | null }>;
      };
      if (active.threads.length > 0) {
        console.log("  active threads (use as target.channelId for type \"thread\"):");
        for (const thread of active.threads) {
          console.log(`    ${thread.name}  ${thread.id}  (parent ${thread.parent_id ?? "?"})`);
        }
      }
    } catch (error) {
      console.warn(`  could not list threads: ${String(error)}`);
    }
  }

  await client.destroy();
}

async function listPins(channelId: string | undefined): Promise<void> {
  if (!channelId || !/^\d{5,25}$/.test(channelId)) usage();

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(process.env.DISCORD_TOKEN);

  try {
    const channel = await client.channels.fetch(channelId as string);
    if (!channel || !channel.isTextBased()) {
      console.error(`Channel ${channelId} is missing or not text-based.`);
      process.exitCode = 1;
      return;
    }

    const pins = await fetchPins(client, channelId as string);
    if (pins.length === 0) {
      console.log(`Channel ${channelId} has no pinned messages.`);
      process.exitCode = 1;
      return;
    }

    console.log(
      `#${"name" in channel ? (channel.name ?? channelId) : channelId} — ` +
        `${pins.length} pinned message(s)\n`,
    );

    pins.forEach((pin, index) => {
      const snippet =
        pin.content.replace(/\s+/g, " ").trim() ||
        pin.embeds[0]?.description ||
        pin.embeds[0]?.title ||
        "(no text)";

      console.log(`  [${index}] ${pin.id}`);
      console.log(`      https://discord.com/channels/${pin.guildId}/${pin.channelId}/${pin.id}`);
      console.log(`      ${snippet.slice(0, 110)}\n`);
    });

    console.log(`Use index 0..${pins.length - 1} in config as { "type": "pin", "index": N }`);
  } catch (error) {
    console.error(`Could not fetch pins for ${channelId}:`, error);
    process.exitCode = 1;
  } finally {
    await client.destroy();
  }
}

const [mode, arg] = process.argv.slice(2);

if (!process.env.DISCORD_TOKEN) {
  console.error("DISCORD_TOKEN is not set. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

if (mode === "ids") {
  void listIds().catch((error) => {
    console.error(error);
    process.exit(1);
  });
} else if (mode === "pins") {
  void listPins(arg).catch((error) => {
    console.error(error);
    process.exit(1);
  });
} else {
  usage();
}
