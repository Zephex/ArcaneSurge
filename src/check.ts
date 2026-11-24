import "dotenv/config";
import { Client, Events, GatewayIntentBits } from "discord.js";
import { loadConfig } from "./config.js";
import { resolveTarget } from "./targets.js";

/**
 * Resolves every configured target against the live API, so a stale pin index
 * or a deleted thread is caught here instead of by a user getting a broken link.
 *
 *   npm run check
 */
async function main(): Promise<void> {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    console.error("DISCORD_TOKEN is not set. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }

  const config = await loadConfig();

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(token);
  if (!client.isReady()) {
    await new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve()));
  }

  let guildId = process.env.GUILD_ID || undefined;
  if (!guildId) {
    const guilds = await client.guilds.fetch();
    const first = guilds.keys().next();
    guildId = first.done ? undefined : first.value;
  }
  if (!guildId) {
    console.error("The bot is not in any guild yet — invite it first.");
    process.exit(1);
  }

  console.log(`Checking ${config.entries.length} entries against guild ${guildId}\n`);

  let failed = 0;
  for (const entry of config.entries) {
    try {
      const url = await resolveTarget(client, guildId, entry.target);
      console.log(`  ok   ${entry.id.padEnd(18)} ${url}`);
    } catch (error) {
      failed += 1;
      console.error(`  FAIL ${entry.id.padEnd(18)} ${(error as Error).message}`);
    }
  }

  await client.destroy();

  const total = config.entries.length;
  console.log(`\n${total - failed} of ${total} entries resolve`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((error) => {
  console.error("check failed:", error);
  process.exitCode = 1;
});
