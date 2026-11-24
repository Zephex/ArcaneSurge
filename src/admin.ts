import "dotenv/config";
import express from "express";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";
import { type FaqConfig, loadConfig } from "./config.js";
import { REST, Routes } from "discord.js";

// Text (0), announcement (5) and forum (15) channels are the ones that carry messages.
const MESSAGE_CHANNEL_TYPES = [0, 5, 15];

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = Number(process.env.ADMIN_PORT) || 3001;
const CLIENT_ID = process.env.CLIENT_ID || "";
const CLIENT_SECRET = process.env.CLIENT_SECRET || "";
const ADMIN_CALLBACK_URL = process.env.ADMIN_CALLBACK_URL || `http://localhost:${PORT}/auth/callback`;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

// In-memory session store
const sessions = new Map<string, { userId: string; username: string; avatar: string | null; guildId: string; expires: number }>();

function createSession(userId: string, username: string, avatar: string | null, guildId: string): string {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { userId, username, avatar, guildId, expires: Date.now() + 24 * 60 * 60 * 1000 });
  return token;
}

function getSession(token: string): { userId: string; username: string; avatar: string | null; guildId: string } | null {
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expires) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  for (const pair of cookieHeader.split(";")) {
    const [key, ...val] = pair.trim().split("=");
    if (key) cookies[key] = val.join("=");
  }
  return cookies;
}

// Auth middleware
function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const cookies = parseCookies(req.headers.cookie);
  const sessionToken = cookies["arcane_session"];
  if (!sessionToken) {
    res.redirect("/login");
    return;
  }
  const session = getSession(sessionToken);
  if (!session) {
    res.redirect("/login");
    return;
  }
  (req as any).session = session;
  next();
}

// Config file path
const CONFIG_PATH = process.env.CONFIG_PATH || "config/faq.json";

// --- Auth routes ---

app.get("/login", (_req, res) => {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    res.status(500).send("Discord OAuth not configured. Set CLIENT_ID and CLIENT_SECRET in .env");
    return;
  }
  const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(ADMIN_CALLBACK_URL)}&response_type=code&scope=identify%20guilds`;
  res.type("html").send(getLoginHtml(discordAuthUrl));
});

app.get("/auth/callback", async (req, res) => {
  const code = req.query.code as string;
  if (!code) {
    res.status(400).send("Missing authorization code");
    return;
  }

  try {
    // Exchange code for access token
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: ADMIN_CALLBACK_URL,
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      console.error("[admin] Token exchange failed:", err);
      res.status(400).send("Failed to authenticate with Discord");
      return;
    }

    const tokenData = (await tokenRes.json()) as { access_token: string };
    const accessToken = tokenData.access_token;

    // Get user info
    const userRes = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!userRes.ok) {
      res.status(400).send("Failed to get user info");
      return;
    }
    const user = (await userRes.json()) as { id: string; username: string; avatar: string | null };

    // Get user's guilds
    const guildsRes = await fetch("https://discord.com/api/v10/users/@me/guilds", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!guildsRes.ok) {
      res.status(400).send("Failed to get guild memberships");
      return;
    }
    const userGuilds = (await guildsRes.json()) as Array<{ id: string; permissions: string }>;

    // Get bot's guilds using bot token
    const botToken = process.env.DISCORD_TOKEN;
    if (!botToken) {
      res.status(500).send("Bot token not configured");
      return;
    }

    const botGuilds = (await new REST().setToken(botToken).get(Routes.userGuilds())) as Array<{ id: string }>;
    const botGuildIds = new Set(botGuilds.map((g) => g.id));

    // Find a guild where both the user and bot are present, and user has admin/manage permissions
    let allowedGuildId: string | null = null;
    for (const ug of userGuilds) {
      if (!botGuildIds.has(ug.id)) continue;
      const perms = BigInt(ug.permissions);
      const isAdmin = (perms & BigInt(0x8)) !== BigInt(0); // Administrator
      const isManager = (perms & BigInt(0x20)) !== BigInt(0); // Manage Server
      if (isAdmin || isManager) {
        allowedGuildId = ug.id;
        break;
      }
    }

    if (!allowedGuildId) {
      // Check if user is in any bot guild but without admin
      const inBotGuild = userGuilds.some((g) => botGuildIds.has(g.id));
      let message: string;
      if (inBotGuild) {
        message = "You are a member of the server where the bot is installed, but you don't have Administrator or Manage Server permissions. Ask a server admin to grant you those permissions, or invite the bot to your own server where you are an admin.";
      } else {
        message = "You are not in any server where the bot is installed. Either ask a server admin to grant you Administrator permissions, or invite the bot to your own server where you are an admin.";
      }
      res.status(403).send(getAccessDeniedHtml(message));
      return;
    }

    // Create session
    const sessionToken = createSession(user.id, user.username, user.avatar, allowedGuildId);
    res.setHeader("Set-Cookie", `arcane_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
    res.redirect("/");
  } catch (error) {
    console.error("[admin] OAuth error:", error);
    res.status(500).send("Authentication failed");
  }
});

app.get("/logout", (_req, res) => {
  const cookies = parseCookies(_req.headers.cookie);
  const token = cookies["arcane_session"];
  if (token) sessions.delete(token);
  res.setHeader("Set-Cookie", "arcane_session=; Path=/; HttpOnly; Max-Age=0");
  res.redirect("/login");
});

// --- Protected routes ---

app.use(requireAuth);

// Serve dashboard
app.get("/", (req, res) => {
  const session = (req as any).session;
  res.type("html").send(getDashboardHtml(session));
});

// API: Get config
app.get("/api/config", async (_req, res) => {
  try {
    const config = await loadConfig(CONFIG_PATH);
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// API: Save config
app.post("/api/config", async (req, res) => {
  try {
    const body = JSON.stringify(req.body as FaqConfig, null, 2) + "\n";
    const candidate = `${CONFIG_PATH}.candidate`;
    writeFileSync(candidate, body, "utf8");
    try {
      await loadConfig(candidate);
    } finally {
      unlinkSync(candidate);
    }
    writeFileSync(CONFIG_PATH, body, "utf8");
    res.json({ ok: true, message: "Saved. The bot picks up the change within a second." });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// API: Get the servers and message channels the bot can see
app.get("/api/status", async (_req, res) => {
  try {
    const token = process.env.DISCORD_TOKEN as string;
    const rest = new REST().setToken(token);
    const guilds = (await rest.get(Routes.userGuilds())) as Array<{ id: string; name: string }>;

    const guildList = [];
    for (const guild of guilds) {
      const channels = (await rest.get(Routes.guildChannels(guild.id))) as Array<{
        id: string;
        name?: string;
        type: number;
        parent_id?: string | null;
      }>;
      const categories = new Map(
        channels.filter((c) => c.type === 4).map((c) => [c.id, c.name ?? ""]),
      );
      guildList.push({
        id: guild.id,
        name: guild.name,
        channels: channels
          .filter((c) => MESSAGE_CHANNEL_TYPES.includes(c.type))
          .map((c) => ({
            id: c.id,
            name: c.name ?? c.id,
            type: c.type,
            category: c.parent_id ? categories.get(c.parent_id) ?? "" : "",
          })),
      });
    }
    res.json({ guilds: guildList });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// API: Get raw config file
app.get("/api/config/raw", (_req, res) => {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    res.type("json").send(raw);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// --- HTML templates ---

function getLoginHtml(discordAuthUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ArcaneSurge Admin — Login</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a2e; color: #e0e0e0; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .login-card { background: #16213e; border-radius: 12px; padding: 40px; text-align: center; max-width: 400px; width: 90%; }
    h1 { color: #5865F2; margin-bottom: 10px; }
    p { color: #a0a0a0; margin-bottom: 30px; line-height: 1.5; }
    .btn-discord { display: inline-block; background: #5865F2; color: white; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-size: 16px; font-weight: 600; transition: background 0.2s; }
    .btn-discord:hover { background: #4752c4; }
    .icon { font-size: 48px; margin-bottom: 20px; }
  </style>
</head>
<body>
  <div class="login-card">
    <div class="icon">⚔️</div>
    <h1>ArcaneSurge Admin</h1>
    <p>Log in with your Discord account. You must have Administrator or Manage Server permissions in a server where the bot is installed.</p>
    <a href="${discordAuthUrl}" class="btn-discord">Login with Discord</a>
  </div>
</body>
</html>`;
}

function getAccessDeniedHtml(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Access Denied</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a2e; color: #e0e0e0; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .card { background: #16213e; border-radius: 12px; padding: 40px; text-align: center; max-width: 480px; width: 90%; }
    h1 { color: #ed4245; margin-bottom: 10px; }
    p { color: #a0a0a0; margin-bottom: 20px; line-height: 1.5; }
    a { color: #5865F2; text-decoration: none; }
    .options { text-align: left; background: #0f3460; padding: 15px; border-radius: 6px; margin: 15px 0; }
    .options li { margin: 8px 0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>⛔ Access Denied</h1>
    <p>${message}</p>
    <div class="options">
      <strong>What you can do:</strong>
      <ul>
        <li>Ask a server admin to grant you <strong>Administrator</strong> or <strong>Manage Server</strong> permissions</li>
        <li>Invite the bot to <strong>your own server</strong> where you are an admin — <a href="https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&permissions=277025475584&scope=bot%20applications.commands" target="_blank">invite link</a></li>
      </ul>
    </div>
    <a href="/login">Try again</a>
  </div>
</body>
</html>`;
}

function getDashboardHtml(session: { username: string; avatar: string | null; userId: string }): string {
  const avatarUrl = session.avatar
    ? `https://cdn.discordapp.com/avatars/${session.userId}/${session.avatar}.png`
    : "https://cdn.discordapp.com/embed/avatars/0.png";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ArcaneSurge Admin</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a2e; color: #e0e0e0; padding: 20px; }
    h1 { color: #5865F2; margin-bottom: 20px; }
    h2 { color: #7289da; margin: 20px 0 10px; }
    .card { background: #16213e; border-radius: 8px; padding: 20px; margin-bottom: 20px; }
    .btn { background: #5865F2; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; margin: 5px; }
    .btn:hover { background: #4752c4; }
    .btn-danger { background: #ed4245; }
    .btn-danger:hover { background: #c03537; }
    .btn-logout { background: #4f545c; }
    input, textarea, select { background: #0f3460; color: #e0e0e0; border: 1px solid #2a2a4a; padding: 8px; border-radius: 4px; width: 100%; margin: 5px 0; font-family: inherit; }
    textarea { min-height: 100px; font-family: monospace; }
    select[multiple] { min-height: 320px; }
    .entry { background: #0f3460; padding: 15px; border-radius: 6px; margin: 10px 0; }
    .entry h3 { color: #57F287; }
    .tag { display: inline-block; background: #5865F2; color: white; padding: 2px 8px; border-radius: 12px; margin: 2px; font-size: 12px; }
    .status { display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 12px; }
    .status.ok { background: #57F287; color: #000; }
    .status.err { background: #ed4245; color: #fff; }
    pre { background: #0f3460; padding: 10px; border-radius: 4px; overflow-x: auto; font-size: 12px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }
    .user-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; }
    .user-bar img { width: 32px; height: 32px; border-radius: 50%; }
    .user-bar a { color: #ed4245; text-decoration: none; margin-left: auto; }
  </style>
</head>
<body>
  <div class="user-bar">
    <img src="${avatarUrl}" alt="avatar">
    <span>Logged in as <strong>${session.username}</strong></span>
    <a href="/logout">Logout</a>
  </div>

  <h1>⚔️ ArcaneSurge Admin</h1>

  <div class="card">
    <h2>Bot Status</h2>
    <div id="status">Loading...</div>
    <button class="btn" onclick="loadStatus()">Refresh Status</button>
  </div>

  <div class="grid">
    <div class="card">
      <h2>Settings</h2>
      <h3>Features</h3>
      <label><input type="checkbox" id="feat-faq"> FAQ keyword replies</label>
      <label><input type="checkbox" id="feat-pobCodes"> PoB code detection (messages, .txt files, Pastebin)</label>
      <label><input type="checkbox" id="feat-poeLinks"> PoE build links (pobb.in, poedb.tw, ...)</label>
      <label><input type="checkbox" id="feat-commands"> Slash commands (/faq, /pob)</label>

      <h3>Channels</h3>
      <p class="hint">Hold Ctrl (Cmd on Mac) to pick several. Nothing selected means the feature works in every channel.</p>
      <label>FAQ keyword replies</label>
      <select multiple size="14" id="ch-messageChannels"></select>
      <label>PoB codes</label>
      <select multiple size="14" id="ch-codeChannels"></select>
      <label>PoE build links</label>
      <select multiple size="14" id="ch-linkChannels"></select>
      <label>Slash commands</label>
      <select multiple size="14" id="ch-commandChannels"></select>

      <h3>Other</h3>
      <label>Embed Color</label>
      <input type="text" id="embedColor" placeholder="#5865F2">
      <label>Reply Mentions</label>
      <select id="replyMentions">
        <option value="false">No (don't ping)</option>
        <option value="true">Yes (ping asker)</option>
      </select>
      <label>Cooldown (seconds)</label>
      <input type="number" id="cooldownSeconds" min="0" max="300">
      <label>Ignore Bots</label>
      <select id="ignoreBots">
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
      <button class="btn" onclick="saveSettings()">Save Settings</button>
    </div>

    <div class="card">
      <h2>FAQ Entries</h2>
      <div id="entries"></div>
      <button class="btn" onclick="addEntry()">+ Add Entry</button>
      <button class="btn" onclick="saveEntries()">Save Entries</button>
    </div>
  </div>

  <div class="card">
    <h2>Raw Config</h2>
    <textarea id="rawConfig" readonly></textarea>
    <button class="btn" onclick="loadRawConfig()">Reload</button>
  </div>

  <script>
    let config = null;

    async function loadConfig() {
      const res = await fetch('/api/config');
      config = await res.json();
      populateForm();
      renderEntries();
      loadRawConfig();
    }

    const CHANNEL_KEYS = ['messageChannels', 'codeChannels', 'linkChannels', 'commandChannels'];
    const FEATURE_KEYS = ['faq', 'pobCodes', 'poeLinks', 'commands'];
    let channelData = [];

    function populateForm() {
      if (!config) return;
      document.getElementById('embedColor').value = config.settings.embedColor;
      document.getElementById('replyMentions').value = String(config.settings.replyMentions);
      document.getElementById('cooldownSeconds').value = config.settings.cooldownSeconds;
      document.getElementById('ignoreBots').value = String(config.settings.ignoreBots);
      for (const f of FEATURE_KEYS) {
        document.getElementById('feat-' + f).checked = config.settings.features[f] !== false;
      }
      buildChannelSelects();
    }

    function buildChannelSelects() {
      for (const key of CHANNEL_KEYS) {
        const sel = document.getElementById('ch-' + key);
        const chosen = (config && config.settings[key]) || [];
        sel.innerHTML = '';
        for (const guild of channelData) {
          const groups = {};
          for (const ch of guild.channels) {
            const cat = ch.category || 'No category';
            (groups[cat] = groups[cat] || []).push(ch);
          }
          for (const cat of Object.keys(groups)) {
            const group = document.createElement('optgroup');
            group.label = guild.name + ' / ' + cat;
            for (const ch of groups[cat]) {
              const opt = document.createElement('option');
              opt.value = ch.id;
              opt.textContent = '#' + ch.name;
              opt.selected = chosen.includes(ch.id);
              group.appendChild(opt);
            }
            sel.appendChild(group);
          }
        }
      }
    }

    function selectedIds(key) {
      return Array.from(document.getElementById('ch-' + key).selectedOptions).map(o => o.value);
    }

    async function saveSettings() {
      if (!config) return;
      config.settings.embedColor = document.getElementById('embedColor').value;
      config.settings.replyMentions = document.getElementById('replyMentions').value === 'true';
      config.settings.cooldownSeconds = Number(document.getElementById('cooldownSeconds').value);
      config.settings.ignoreBots = document.getElementById('ignoreBots').value === 'true';
      for (const key of CHANNEL_KEYS) config.settings[key] = selectedIds(key);
      for (const f of FEATURE_KEYS) config.settings.features[f] = document.getElementById('feat-' + f).checked;
      await saveConfig();
    }

    function renderEntries() {
      const container = document.getElementById('entries');
      if (!config || !config.entries) { container.innerHTML = '<p>No entries</p>'; return; }
      container.innerHTML = config.entries.map((e, i) => \`
        <div class="entry">
          <h3>\${e.id}</h3>
          <label>Label</label>
          <input type="text" value="\${e.label}" onchange="config.entries[\${i}].label = this.value">
          <label>Triggers (comma-separated)</label>
          <input type="text" value="\${e.triggers.join(', ')}" onchange="config.entries[\${i}].triggers = this.value.split(',').map(s=>s.trim()).filter(s=>s)">
          <label>Message</label>
          <textarea onchange="config.entries[\${i}].message = this.value">\${e.message}</textarea>
          <label>Target Type</label>
          <select onchange="config.entries[\${i}].target.type = this.value">
            <option value="pin" \${e.target.type==='pin'?'selected':''}>Pin</option>
            <option value="thread" \${e.target.type==='thread'?'selected':''}>Thread/Message</option>
            <option value="url" \${e.target.type==='url'?'selected':''}>URL</option>
          </select>
          <label>Target Channel ID</label>
          <input type="text" value="\${e.target.channelId || ''}" onchange="config.entries[\${i}].target.channelId = this.value">
          <label>Target Index (for pins)</label>
          <input type="number" value="\${e.target.index || 0}" onchange="config.entries[\${i}].target.index = Number(this.value)">
          <label>Target Message ID (for threads)</label>
          <input type="text" value="\${e.target.messageId || ''}" onchange="config.entries[\${i}].target.messageId = this.value">
          <label>Target URL (for urls)</label>
          <input type="text" value="\${e.target.url || ''}" onchange="config.entries[\${i}].target.url = this.value">
          <label>Color</label>
          <input type="text" value="\${e.color || ''}" onchange="config.entries[\${i}].color = this.value">
          <button class="btn btn-danger" onclick="removeEntry(\${i})">Remove</button>
        </div>
      \`).join('');
    }

    function addEntry() {
      if (!config) return;
      const id = prompt("Entry ID (e.g., 'verification'):");
      if (!id) return;
      config.entries.push({
        id,
        label: id,
        triggers: [],
        target: { type: "url", url: "https://example.com" },
        message: "Description here",
      });
      renderEntries();
    }

    function removeEntry(i) {
      if (!config) return;
      if (confirm('Remove entry "' + config.entries[i].id + '"?')) {
        config.entries.splice(i, 1);
        renderEntries();
      }
    }

    async function saveEntries() {
      await saveConfig();
    }

    async function saveConfig() {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      const data = await res.json();
      if (data.ok) {
        alert(data.message || 'Saved.');
      } else {
        alert('Error: ' + (data.error || 'Unknown error'));
      }
    }

    async function loadStatus() {
      const res = await fetch('/api/status');
      const data = await res.json();
      const container = document.getElementById('status');
      if (data.error) {
        container.innerHTML = '<span class="status err">Error: ' + data.error + '</span>';
        return;
      }
      channelData = data.guilds;
      let html = '<span class="status ok">Connected</span><br>';
      for (const guild of data.guilds) {
        html += '<br><strong>' + guild.name + '</strong> (' + guild.id + ')<br>';
        html += '<small>' + guild.channels.length + ' message channels</small><br>';
      }
      container.innerHTML = html;
      buildChannelSelects();
    }

    async function loadRawConfig() {
      const res = await fetch('/api/config/raw');
      const text = await res.text();
      document.getElementById('rawConfig').value = text;
    }

    loadConfig().then(loadStatus);
  </script>
</body>
</html>`;
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[admin] Admin interface running on http://0.0.0.0:${PORT}`);
  console.log(`[admin] Discord OAuth: ${CLIENT_ID ? "configured" : "NOT configured (set CLIENT_ID and CLIENT_SECRET)"}`);
});

export { app };