import { type Client, type Message, type Snowflake } from "discord.js";
import type { Target } from "./config.js";

/** Pins change rarely; re-fetching every hit would burn the rate limit. */
const PIN_TTL_MS = 60_000;

const pinCache = new Map<string, { pins: Message[]; at: number }>();

export function clearPinCache(): void {
  pinCache.clear();
}

/** Fetch (and briefly cache) a channel's pinned messages. Also used by tools.ts. */
export async function fetchPins(client: Client, channelId: string): Promise<Message[]> {
  const cached = pinCache.get(channelId);
  if (cached && Date.now() - cached.at < PIN_TTL_MS) return cached.pins;

  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) {
    throw new Error(
      `channel ${channelId} is missing, deleted, or is not a text-based channel`,
    );
  }

  const messages = (
    channel as unknown as {
      messages?: {
        fetchPins(options?: { limit?: number }): Promise<{ items: readonly { message: Message }[] }>;
      };
    }
  ).messages;
  if (!messages?.fetchPins) {
    throw new Error(`channel ${channelId} does not support fetching pinned messages`);
  }

  // 50 is Discord's maximum page size for pins, so a single call is enough.
  const { items } = await messages.fetchPins({ limit: 50 });
  const pins = items.map((item) => item.message);
  pinCache.set(channelId, { pins, at: Date.now() });
  return pins;
}

/**
 * Turn a configured target into a jump URL.
 *
 * @throws with an actionable message when the target cannot be resolved.
 */
export async function resolveTarget(
  client: Client,
  guildId: Snowflake,
  target: Target,
): Promise<string> {
  switch (target.type) {
    case "url":
      return target.url;

    case "thread":
      return target.messageId
        ? `https://discord.com/channels/${guildId}/${target.channelId}/${target.messageId}`
        : `https://discord.com/channels/${guildId}/${target.channelId}`;

    case "pin": {
      const pins = await fetchPins(client, target.channelId);
      if (pins.length === 0) {
        throw new Error(
          `channel ${target.channelId} has no pinned messages — pin the FAQ message ` +
            `there, or point this entry at a url/thread instead`,
        );
      }
      const index = target.index ?? 0;
      const pin = pins[index];
      if (!pin) {
        throw new Error(
          `pin index ${index} is out of range — channel ${target.channelId} only has ` +
            `${pins.length} pinned message(s)`,
        );
      }
      return `https://discord.com/channels/${guildId}/${pin.channelId}/${pin.id}`;
    }
  }
}
