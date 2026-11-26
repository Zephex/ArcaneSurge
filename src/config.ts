import { readFile } from "node:fs/promises";

/**
 * Where a trigger points. Three shapes cover pinned messages, forum posts
 * (a forum post *is* a thread, so `thread` covers both) and plain links.
 */
export type Target =
  | { type: "pin"; channelId: string; index?: number }
  | { type: "thread"; channelId: string; messageId?: string }
  | { type: "url"; url: string };

export interface Entry {
  /** Stable identifier, used in logs. */
  id: string;
  /** Embed title. */
  label: string;
  /** Words, phrases, or /regex/literals that fire this entry. */
  triggers: string[];
  target: Target;
  /** Embed body. */
  message: string;
  /** Hex colour, e.g. "#57F287". Falls back to settings.embedColor. */
  color?: string;
  /** If set, this entry only fires in these channels. */
  channelIds?: string[];
}

export interface Settings {
  embedColor: string;
  /** Whether the reply pings the person who asked. */
  replyMentions: boolean;
  /** Per-user cooldown between responses, in seconds. */
  cooldownSeconds: number;
  /** Ignore messages from other bots (prevents reply loops). */
  ignoreBots: boolean;
  /** If non-empty, the bot only listens for FAQ keyword triggers in these channels. */
  messageChannels: string[];
  /** If non-empty, the bot only detects PoB codes in these channels. */
  codeChannels: string[];
  /** If non-empty, slash commands only work in these channels. */
  commandChannels: string[];
  /** If non-empty, PoE build links (pobb.in, Pastebin, ...) are only handled in these channels. */
  linkChannels: string[];
  /** Turn whole features on or off. */
  features: Features;
}

export interface Features {
  faq: boolean;
  pobCodes: boolean;
  poeLinks: boolean;
  commands: boolean;
}

export interface ReactionRolePost {
  /** Discord message ID of the bot's post. */
  messageId: string;
  channelId: string;
  guildId: string;
  /** The message text, stored so it can be edited later. */
  content?: string;
  /** Emoji (Unicode or custom <:name:id>) -> role ID. */
  roles: Record<string, string>;
}

export interface FaqConfig {
  settings: Settings;
  entries: Entry[];
  reactionPosts?: ReactionRolePost[];
}

const DEFAULT_SETTINGS: Settings = {
  embedColor: "#5865F2",
  replyMentions: false,
  cooldownSeconds: 10,
  ignoreBots: true,
  messageChannels: [],
  codeChannels: [],
  commandChannels: [],
  linkChannels: [],
  features: { faq: true, pobCodes: true, poeLinks: true, commands: true },
};

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

function fail(where: string, message: string): never {
  throw new ConfigError(`${where}: ${message}`);
}

function isSnowflake(value: unknown): value is string {
  return typeof value === "string" && /^\d{5,25}$/.test(value);
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function asObject(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(where, "expected an object");
  }
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    fail(where, "expected an array of strings");
  }
  return value as string[];
}

function validateTarget(raw: unknown, where: string): Target {
  const target = asObject(raw, where);
  const type = target.type;

  if (type === "url") {
    if (typeof target.url !== "string" || !/^https?:\/\//.test(target.url)) {
      fail(`${where}.url`, 'expected an http(s) URL, e.g. "https://example.com/faq"');
    }
    return { type: "url", url: target.url };
  }

  if (type === "pin" || type === "thread") {
    if (!isSnowflake(target.channelId)) {
      fail(
        `${where}.channelId`,
        `expected a channel ID (got ${JSON.stringify(target.channelId)}). Run \`npm run ids\` to list them.`,
      );
    }
    if (target.messageId !== undefined && !isSnowflake(target.messageId)) {
      fail(`${where}.messageId`, "expected a message ID (digits only)");
    }
    if (type === "pin") {
      if (target.index !== undefined && (!Number.isInteger(target.index) || (target.index as number) < 0)) {
        fail(`${where}.index`, "expected a non-negative integer (0 = top pin)");
      }
      return {
        type: "pin",
        channelId: target.channelId,
        ...(target.index !== undefined ? { index: target.index as number } : {}),
      };
    }
    return {
      type: "thread",
      channelId: target.channelId,
      ...(target.messageId !== undefined ? { messageId: target.messageId as string } : {}),
    };
  }

  fail(
    `${where}.type`,
    `expected "pin", "thread" or "url" (got ${JSON.stringify(type)})`,
  );
}

function validateReactionPosts(raw: unknown): ReactionRolePost[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail("config.reactionPosts", "expected an array");
  return raw.map((value, index) => {
    const where = `reactionPosts[${index}]`;
    const post = asObject(value, where);
    if (!isSnowflake(post.messageId)) fail(`${where}.messageId`, "expected a message ID");
    if (!isSnowflake(post.channelId)) fail(`${where}.channelId`, "expected a channel ID");
    if (!isSnowflake(post.guildId)) fail(`${where}.guildId`, "expected a guild ID");
    if (post.roles === null || typeof post.roles !== "object" || Array.isArray(post.roles)) {
      fail(`${where}.roles`, "expected an object mapping emoji to role ID");
    }
    const roles: Record<string, string> = {};
    for (const [emoji, roleId] of Object.entries(post.roles as Record<string, unknown>)) {
      if (!emoji) fail(`${where}.roles`, "empty emoji key");
      if (!isSnowflake(roleId)) fail(`${where}.roles[${emoji}]`, "expected a role ID");
      roles[emoji] = roleId;
    }
    const content = typeof post.content === "string" ? post.content : undefined;
    return {
      messageId: post.messageId,
      channelId: post.channelId,
      guildId: post.guildId,
      ...(content !== undefined ? { content } : {}),
      roles,
    };
  });
}

function validateEntry(raw: unknown, index: number): Entry {
  const where = `entries[${index}]`;
  const entry = asObject(raw, where);

  if (typeof entry.id !== "string" || !entry.id.trim()) {
    fail(`${where}.id`, "expected a non-empty string");
  }
  const label = `${where} ("${entry.id}")`;

  if (typeof entry.label !== "string" || !entry.label.trim()) {
    fail(`${label}.label`, "expected a non-empty string (shown as the embed title)");
  }
  if (typeof entry.message !== "string" || !entry.message.trim()) {
    fail(`${label}.message`, "expected a non-empty string (shown as the embed body)");
  }

  const triggers = asStringArray(entry.triggers, `${label}.triggers`);
  if (triggers.length === 0) {
    fail(`${label}.triggers`, "at least one trigger is required");
  }
  if (triggers.some((t) => !t.trim())) {
    fail(`${label}.triggers`, "contains an empty trigger");
  }

  if (entry.color !== undefined && (typeof entry.color !== "string" || !HEX_COLOR.test(entry.color))) {
    fail(`${label}.color`, 'expected a hex colour like "#57F287"');
  }

  let channelIds: string[] | undefined;
  if (entry.channelIds !== undefined) {
    channelIds = asStringArray(entry.channelIds, `${label}.channelIds`);
    const bad = channelIds.find((id) => !isSnowflake(id));
    if (bad !== undefined) fail(`${label}.channelIds`, `"${bad}" is not a channel ID`);
  }

  return {
    id: entry.id,
    label: entry.label,
    triggers,
    target: validateTarget(entry.target, `${label}.target`),
    message: entry.message,
    ...(entry.color !== undefined ? { color: entry.color as string } : {}),
    ...(channelIds !== undefined ? { channelIds } : {}),
  };
}

function validateSettings(raw: unknown): Settings {
  const where = "settings";
  const source = raw === undefined ? {} : asObject(raw, where);

  const settings: Settings = { ...DEFAULT_SETTINGS, features: { ...DEFAULT_SETTINGS.features } };

  if (source.embedColor !== undefined) {
    if (typeof source.embedColor !== "string" || !HEX_COLOR.test(source.embedColor)) {
      fail(`${where}.embedColor`, 'expected a hex colour like "#5865F2"');
    }
    settings.embedColor = source.embedColor;
  }
  if (source.replyMentions !== undefined) {
    if (typeof source.replyMentions !== "boolean") fail(`${where}.replyMentions`, "expected true or false");
    settings.replyMentions = source.replyMentions;
  }
  if (source.ignoreBots !== undefined) {
    if (typeof source.ignoreBots !== "boolean") fail(`${where}.ignoreBots`, "expected true or false");
    settings.ignoreBots = source.ignoreBots;
  }
  if (source.cooldownSeconds !== undefined) {
    if (typeof source.cooldownSeconds !== "number" || source.cooldownSeconds < 0) {
      fail(`${where}.cooldownSeconds`, "expected a number >= 0");
    }
    settings.cooldownSeconds = source.cooldownSeconds;
  }
  if (source.messageChannels !== undefined) {
    const ids = asStringArray(source.messageChannels, `${where}.messageChannels`);
    const bad = ids.find((id) => !isSnowflake(id));
    if (bad !== undefined) fail(`${where}.messageChannels`, `"${bad}" is not a channel ID`);
    settings.messageChannels = ids;
  }
  if (source.codeChannels !== undefined) {
    const ids = asStringArray(source.codeChannels, `${where}.codeChannels`);
    const bad = ids.find((id) => !isSnowflake(id));
    if (bad !== undefined) fail(`${where}.codeChannels`, `"${bad}" is not a channel ID`);
    settings.codeChannels = ids;
  }
  if (source.commandChannels !== undefined) {
    const ids = asStringArray(source.commandChannels, `${where}.commandChannels`);
    const bad = ids.find((id) => !isSnowflake(id));
    if (bad !== undefined) fail(`${where}.commandChannels`, `"${bad}" is not a channel ID`);
    settings.commandChannels = ids;
  }
  if (source.linkChannels !== undefined) {
    const ids = asStringArray(source.linkChannels, `${where}.linkChannels`);
    const bad = ids.find((id) => !isSnowflake(id));
    if (bad !== undefined) fail(`${where}.linkChannels`, `"${bad}" is not a channel ID`);
    settings.linkChannels = ids;
  }
  if (source.features !== undefined) {
    const features = asObject(source.features, `${where}.features`);
    for (const key of Object.keys(DEFAULT_SETTINGS.features) as Array<keyof Features>) {
      if (features[key] === undefined) continue;
      if (typeof features[key] !== "boolean") fail(`${where}.features.${key}`, "expected true or false");
      settings.features[key] = features[key] as boolean;
    }
  }

  const unknown = Object.keys(source).filter(
    (key) => !(key in DEFAULT_SETTINGS),
  );
  if (unknown.length > 0) {
    console.warn(`[faq] ignoring unknown setting(s): ${unknown.join(", ")}`);
  }

  return settings;
}

/** Read, parse and validate `config/faq.json` (or CONFIG_PATH). */
export async function loadConfig(
  configPath: string = process.env.CONFIG_PATH ?? "config/faq.json",
): Promise<FaqConfig> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      fail("config", `could not find ${configPath}. Copy config/faq.example.json or set CONFIG_PATH.`);
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail("config", `${configPath} is not valid JSON: ${(error as Error).message}`);
  }

  const root = asObject(parsed, "config");
  const entriesRaw = root.entries;
  if (!Array.isArray(entriesRaw) || entriesRaw.length === 0) {
    fail("config.entries", "expected a non-empty array");
  }

  const entries = entriesRaw.map(validateEntry);

  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) fail("config.entries", `duplicate entry id "${entry.id}"`);
    seen.add(entry.id);
  }

  return {
    settings: validateSettings(root.settings),
    entries,
    reactionPosts: validateReactionPosts(root.reactionPosts),
  };
}
