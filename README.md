# discord-faq-bot

A Discord bot that watches for common questions and replies with a link to the
right answer — a pinned message, a forum post, or an external doc.

Everything is driven by `config/faq.json`. No code changes needed to add a topic.

## How it works

1. The bot reads incoming messages and normalises them
   (`"How do I get verified?"` → `"how do i get verified"`).
2. Each trigger is matched with **word boundaries**, so `rules` matches
   `"read the safety rules"` but not `"safetyrules"`.
3. When several triggers match, the **longest wins**, so a specific phrase beats
   a short generic one no matter which order they appear in.
4. On a match the bot replies with an embed whose title, body and link come from
   the config entry.

## Setup

### 1. Create the application

1. <https://discord.com/developers/applications> → **New Application**
2. **Bot** → **Reset Token** → copy it
3. Still under **Bot** → **Privileged Gateway Intents** → turn on
   **Message Content Intent**

> **This step is required.** Without it the gateway closes with `4014` on
> connect, or the bot connects but every message arrives with empty content —
> so nothing will ever match. It is the single most common reason "the bot
> doesn't respond".

4. **OAuth2 → URL Generator** → scopes `bot` and `applications.commands` →
   invite the bot to your server (it needs *Send Messages*, *Embed Links* and
   *Read Message History*).

### 2. Configure

```bash
cp .env.example .env
```

| Variable | Required | Notes |
|---|---|---|
| `DISCORD_TOKEN` | yes | Bot token from step 1.2 |
| `CLIENT_ID` | for `/faq` | Application ID → General Information |
| `GUILD_ID` | recommended | Registers `/faq` to one server so it appears **instantly**. Omit and it registers globally, which can take up to an hour. |
| `CONFIG_PATH` | no | Defaults to `config/faq.json` |
| `DEBUG` | no | Set to `1` for verbose gateway logging |

Never commit `.env`.

### 3. Fill in the config

Use the helper scripts to discover IDs instead of digging through the dev tools:

```bash
npm run ids                 # guilds, channels, active threads
npm run pins -- <channelId> # a channel's pins, with index and jump link
npm run check               # resolve every target in the config against the API
```

`config/faq.json` ships pre-wired for one server as a worked example — swap in
your own guild and channel IDs.

```jsonc
{
  "settings": {
    "embedColor": "#5865F2",
    "replyMentions": false,   // true = the reply pings whoever asked
    "cooldownSeconds": 10,    // per-user throttle
    "ignoreBots": true,       // prevents reply loops
    "channelAllowlist": []    // non-empty = only listen in these channels
  },
  "entries": [
    {
      "id": "verification",          // stable id, used in logs
      "label": "Verification",       // embed title
      "triggers": ["verification", "how do i get verified", "/how.*verif/i"],
      "target": { "type": "pin", "channelId": "…", "index": 0 },
      "message": "Everything about getting verified is in the pinned guide.",
      "color": "#57F287",            // optional per-entry colour
      "channelIds": ["…"]            // optional: only fire in these channels
    }
  ]
}
```

#### Target types

| Type | Points at | Example |
|---|---|---|
| `{ "type": "pin", "channelId": "…", "index": 0 }` | The *n*-th pinned message in a channel (`0` = top pin). Pins are cached for 60s. | `{ "type": "pin", "channelId": "123", "index": 1 }` |
| `{ "type": "thread", "channelId": "…" }` | A thread or forum post. A forum post **is** a thread, so this covers both. | `{ "type": "thread", "channelId": "123" }` |
| `{ "type": "thread", "channelId": "…", "messageId": "…" }` | Any specific message — a rules post, an announcement, a reply. Without `messageId` it jumps to the channel, thread or forum itself. | `{ "type": "thread", "channelId": "123", "messageId": "456" }` |
| `{ "type": "url", "url": "https://…" }` | Any http(s) URL — Notion, docs site, GitHub README. | `{ "type": "url", "url": "https://example.com/faq" }` |

Mixing them is fine: some entries can point at pins while others point at docs.

#### Triggers

- **Phrases** are matched case-insensitively with flexible whitespace and word
  boundaries. Punctuation in both the trigger and the message is ignored, so
  `"How do I get verified?"` and `"how do i get verified"` are the same thing.
- **Regex** triggers use `/pattern/flags` and run against the raw message.
  Use these for literal symbols:

  ```jsonc
  "triggers": ["/c\\+\\+/i", "/c#/i", "general help"]
  ```

  This matters: symbols are stripped during normalisation, so a trigger like
  `C#` would reduce to `c` and match any lone letter. The config loader **rejects**
  triggers that collapse to a lone short token and tells you to use a regex instead.
- **Priority**: longest matching trigger wins; ties go to whichever entry
  appears first in `config.entries`.

## Running

```bash
npm install
npm test          # 21 checks on matching, priority and config validation
npm run check     # every configured target resolves against the live server
npm run dev       # auto-restarts on file changes
```

Production:

```bash
npm run build
npm start
```

## Commands

| Command | Effect |
|---|---|
| `/faq` | Lists every configured topic (ephemeral). |
| `/faq query:<text>` | Tests a phrase against the config — the fastest way to tune triggers without spamming a channel. |
| `/pob <code>` | Decodes a Path of Building share code and shows build info (class, ascendancy, level, skills, notes). |

## Path of Exile support

The bot includes Path of Exile third-party tool support:

- **`/pob <code>`** — Paste a PoB share code to get a decoded build summary embed
- **Auto-detection** — When someone pastes a PoB code in a channel, the bot automatically decodes it and replies with build info
- **FAQ entries** — PoE/PoB related questions are answered with links to the FAQ forum

PoB codes are URL-safe base64 of zlib-compressed XML. The decoder handles both PoE1 and PoE2 formats.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Bot connects but never replies | **Message Content Intent** is off (Setup step 1.3). |
| Gateway closes with `4014` | Same as above, or the bot lacks a privileged intent. |
| `DISCORD_TOKEN is not set` | Copy `.env.example` → `.env`. |
| `channel … has no pinned messages` | Pin the FAQ message, or point the entry at a `thread`/`url` target. |
| `pin index N is out of range` | The channel has fewer pins than you asked for. Run `npm run pins -- <id>`. |
| A link 404s or points at the wrong post | A pin was moved or a thread archived. Run `npm run check`. |
| `/faq` missing from the command list | Global registration can take up to an hour — set `GUILD_ID` for instant registration. |
| Bot replies twice per message | Lower `cooldownSeconds`, or make sure `ignoreBots` is `true`. |

Logs are prefixed with `[faq]`. Set `DEBUG=1` for full gateway output.

## Admin web interface

The bot includes a web-based admin interface for managing config, channels, and settings.

### Running locally

The admin interface starts automatically with the bot on port 3001 (configurable via `ADMIN_PORT`).

```bash
npm run dev  # bot + admin interface on http://localhost:3001
```

### Discord OAuth login

The admin interface uses Discord OAuth2 for authentication. Only users with **Administrator** or **Manage Server** permissions in a guild where the bot is installed can log in.

Required env vars:
- `CLIENT_ID` — Discord application ID
- `CLIENT_SECRET` — Discord OAuth2 client secret (Developer Portal → OAuth2 → Reset Secret)
- `ADMIN_CALLBACK_URL` — OAuth2 callback URL (default: `http://localhost:3001/auth/callback`)

### Hosting on your domain

1. **DNS**: Point your domain's A record to your server IP

2. **Add reverse proxy config**: Add this block to your Caddyfile (or nginx config):

```
bot.your-domain.com {
    reverse_proxy 127.0.0.1:3001
}
```

3. **Reload your reverse proxy**: `sudo caddy reload --config /etc/caddy/Caddyfile` or `sudo systemctl restart caddy`

4. **Set env vars**:
```env
ADMIN_PORT=3001
ADMIN_CALLBACK_URL=https://bot.your-domain.com/auth/callback
```

5. **Discord OAuth redirect**: Add `https://bot.your-domain.com/auth/callback` to Developer Portal → OAuth2 → Redirects

6. **Access**: https://bot.your-domain.com/login

## Layout

```
config/faq.json   triggers and targets — edit this, not the code
src/config.ts     loads and validates the config
src/matcher.ts    normalisation, word boundaries, priority, regex triggers
src/targets.ts    turns a target into a jump URL (pins are cached)
src/pob.ts       PoB share code decoder (base64 + zlib) + XML parser
src/poeLinks.ts  PoE build link detection (pobb.in, poedb.tw, maxroll, etc.)
src/admin.ts     admin web interface with Discord OAuth
src/index.ts      gateway wiring, replies, /faq and /pob commands
src/tools.ts      `npm run ids` / `npm run pins` helpers
src/check.ts      `npm run check` — validates every target resolves
src/selftest.ts   `npm test`
```
