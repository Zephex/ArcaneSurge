import { decode as pobDecode } from "pob-parser";

/**
 * Decode a Path of Building share code into its raw XML.
 *
 * PoB codes are URL-safe base64 of a zlib-compressed XML document. The
 * original PoE1 format uses `<PathOfBuilding>` as the root element; PoE2
 * uses `<PathOfBuilding2>`.
 *
 * @throws when the input is not a valid PoB code.
 */
export async function decodePobCode(code: string): Promise<string> {
  const trimmed = code.trim();

  let xml: string;
  try {
    xml = await pobDecode(trimmed);
  } catch {
    throw new Error(
      "Could not decode the share code. Make sure it's a valid Path of Building export code.",
    );
  }

  if (!xml.includes("<PathOfBuilding") && !xml.includes("<PathOfBuilding2")) {
    throw new Error("The decoded data does not look like a Path of Building build.");
  }

  return xml;
}

const POBBIN_UPLOAD_URL = "https://pobb.in/pob/";
const POBBIN_USER_AGENT = "ArcaneSurge-Discord-Bot/1.0 (contact: discord ArcaneSurge)";

/**
 * Upload a PoB share code to pobb.in and return the public link.
 * Returns null if the upload fails or pobb.in rejects the code.
 * Note: pobb.in pastes are public.
 */
export async function uploadToPobbin(code: string): Promise<string | null> {
  try {
    const response = await fetch(POBBIN_UPLOAD_URL, {
      method: "POST",
      headers: { "User-Agent": POBBIN_USER_AGENT, "Content-Type": "text/plain" },
      body: code.trim(),
    });
    if (!response.ok) return null;
    const id = (await response.text()).trim();
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) return null;
    return `https://pobb.in/${id}`;
  } catch {
    return null;
  }
}

/** Parse equipped items from the active item set. */
function parseItems(xml: string): PobItem[] {
  const items: PobItem[] = [];

  // Find the active item set (first one with id="1" or the one marked active)
  // PoB typically has multiple ItemSets; use the one with the highest id or "Endgame"
  const itemSetRegex = /<ItemSet[^>]*title="([^"]*)"[^>]*id="([^"]*)"[^>]*>([\s\S]*?)<\/ItemSet>/gi;
  const itemSets: { title: string; id: string; content: string }[] = [];
  let setMatch: RegExpExecArray | null;
  while ((setMatch = itemSetRegex.exec(xml)) !== null) {
    itemSets.push({ title: setMatch[1] ?? "", id: setMatch[2] ?? "", content: setMatch[3] ?? "" });
  }

  // Prefer "Endgame" or highest id
  let activeSet = itemSets.find((s) => s.title.toLowerCase().includes("endgame"));
  if (!activeSet && itemSets.length > 0) {
    activeSet = itemSets[itemSets.length - 1];
  }
  if (!activeSet) return items;

  // Build item id -> item text map
  const itemMap = new Map<string, string>();
  const itemRegex = /<Item id="(\d+)"[^>]*>([\s\S]*?)<\/Item>/gi;
  let itemMatch: RegExpExecArray | null;
  while ((itemMatch = itemRegex.exec(xml)) !== null) {
    itemMap.set(itemMatch[1] ?? "", (itemMatch[2] ?? "").trim());
  }

  // Parse slots
  const slotRegex = /<Slot[^>]*name="([^"]*)"[^>]*itemId="(\d+)"[^>]*>/gi;
  let slotMatch: RegExpExecArray | null;
  while ((slotMatch = slotRegex.exec(activeSet.content)) !== null) {
    const slot = slotMatch[1] ?? "";
    const itemId = slotMatch[2] ?? "";
    if (itemId === "0") continue; // Empty slot

    const itemText = itemMap.get(itemId);
    if (!itemText) continue;

    // Parse item text
    const lines = itemText.split("\n").map((l) => l.trim()).filter(Boolean);
    let rarity = "NORMAL";
    let name = "";
    let baseType = "";

    for (const line of lines) {
      if (line.startsWith("Rarity:")) {
        rarity = line.replace("Rarity:", "").trim().toUpperCase();
      } else if (!name && line && !line.includes(":") && !line.startsWith("{")) {
        // First non-rarity, non-property line is the name
        if (!name) name = line;
        else if (!baseType) baseType = line;
      }
    }

    // If name is "New Item", try to get from base type
    if (name === "New Item" || !name) {
      // Look for base type in the item text
      const baseMatch = itemText.match(/Rarity:.*\n(?:New Item\n)?(.+)/);
      if (baseMatch) {
        const candidate = (baseMatch[1] ?? "").trim();
        if (candidate && !candidate.includes(":")) {
          name = candidate;
        }
      }
    }

    // Simplify: use first two non-empty lines after Rarity as name/base
    const itemLines = itemText.split("\n").map((l) => l.trim()).filter(Boolean);
    let idx = 0;
    if ((itemLines[idx] ?? "").startsWith("Rarity:")) idx++;
    if (itemLines[idx] === "New Item") idx++;
    if (idx < itemLines.length && !(itemLines[idx] ?? "").includes(":")) {
      name = itemLines[idx] ?? "";
      idx++;
    }
    if (idx < itemLines.length && !(itemLines[idx] ?? "").includes(":") && !(itemLines[idx] ?? "").startsWith("{")) {
      baseType = itemLines[idx] ?? "";
    }

    if (name || baseType) {
      // Decode HTML entities
      const decode = (s: string) => s.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
      items.push({
        slot,
        name: decode(name || baseType || "Unknown"),
        baseType: decode(baseType || name || "Unknown"),
        rarity,
      });
    }
  }

  return items;
}

/** Parse key stats from PlayerStat elements. */
function parseStats(xml: string): PobSummary["stats"] {
  const stats: PobSummary["stats"] = {};
  const statMap: Record<string, keyof PobSummary["stats"]> = {
    Life: "life",
    EnergyShield: "energyShield",
    Mana: "mana",
    CombinedDPS: "dps",
    TotalDPS: "dps",
    FireResist: "fireRes",
    ColdResist: "coldRes",
    LightningResist: "lightningRes",
    ChaosResist: "chaosRes",
  };

  for (const [statName, key] of Object.entries(statMap)) {
    const re = new RegExp(`<PlayerStat stat="${statName}" value="([^"]*)"`, "i");
    const m = xml.match(re);
    if (m && m[1]) {
      const val = Number(m[1]);
      if (!isNaN(val) && val > 0) {
        // Don't overwrite dps if already set by CombinedDPS
        if (key === "dps" && stats.dps !== undefined && statName === "TotalDPS") continue;
        (stats as any)[key] = val;
      }
    }
  }

  return stats;
}

/** Parse passive points from the active spec. */
function parsePassivePoints(xml: string): number | undefined {
  // Find the last spec (highest level) and count nodes
  const specRegex = /<Spec\s[^>]*>/gi;
  const specs: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = specRegex.exec(xml)) !== null) {
    specs.push(m[0]);
  }
  if (specs.length === 0) return undefined;

  const lastSpec = specs[specs.length - 1] ?? "";
  const nodesMatch = lastSpec.match(/nodes="([^"]*)"/);
  if (!nodesMatch || !nodesMatch[1]) return undefined;

  const nodes = (nodesMatch[1] ?? "").split(",").filter((n) => n.trim().length > 0);
  return nodes.length;
}

/** Extract a single attribute value from an XML tag. */
function attr(tag: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}="([^"]*)"`, "i");
  const m = tag.match(re);
  return m ? m[1] : undefined;
}

export interface PobItem {
  slot: string;
  name: string;
  baseType: string;
  rarity: string;
}

export interface PobSummary {
  /** "PoE 1" or "PoE 2" */
  game: "PoE 1" | "PoE 2";
  /** Character class, e.g. "Shadow" */
  className?: string;
  /** Ascendancy, e.g. "Trickster" */
  ascendancy?: string;
  /** Character level */
  level?: number;
  /** The active skill set's first skill gem name */
  mainSkill?: string;
  /** All skill names from the active skill set */
  skills: string[];
  /** Build notes if present */
  notes?: string;
  /** Equipped items (from the active item set) */
  items: PobItem[];
  /** Key stats */
  stats: {
    life?: number;
    energyShield?: number;
    mana?: number;
    dps?: number;
    fireRes?: number;
    coldRes?: number;
    lightningRes?: number;
    chaosRes?: number;
  };
  /** Number of passive points allocated */
  passivePoints?: number;
}

/**
 * Parse a PoB XML string into a structured summary.
 */
export function parsePobSummary(xml: string): PobSummary {
  const isPoe2 = xml.includes("<PathOfBuilding2");
  const game: PobSummary["game"] = isPoe2 ? "PoE 2" : "PoE 1";

  // Build tag attributes
  const buildMatch = xml.match(/<Build\s[^>]*>/i);
  const buildTag = buildMatch ? buildMatch[0] : "";

  const className = attr(buildTag, "className") || attr(buildTag, "characterClass");
  const ascendancy = attr(buildTag, "ascendClassName");
  const levelStr = attr(buildTag, "level") || attr(buildTag, "characterLevel");
  const level = levelStr ? Number(levelStr) : undefined;

  // Active skill set
  const activeSkillSetId = attr(buildTag, "mainSocketGroup") || "1";

  // Find skill gems from the first active skill
  const skills: string[] = [];
  let mainSkill: string | undefined;

  // Match all Skill elements and extract Gem nameSpec
  const skillRegex = /<Skill\s[^>]*>([\s\S]*?)<\/Skill>/gi;
  let skillMatch: RegExpExecArray | null;
  while ((skillMatch = skillRegex.exec(xml)) !== null) {
    const skillBlock = skillMatch[1] ?? "";
    const gemRegex = /<Gem\s[^>]*nameSpec="([^"]*)"[^>]*>/gi;
    let gemMatch: RegExpExecArray | null;
    while ((gemMatch = gemRegex.exec(skillBlock)) !== null) {
      const gemName = gemMatch[1] ?? "";
      if (gemName && !skills.includes(gemName)) {
        skills.push(gemName);
      }
    }
  }

  // The first skill gem is typically the main skill
  if (skills.length > 0) {
    mainSkill = skills[0];
  }

  // Notes
  const notesMatch = xml.match(/<Notes>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/Notes>/i)
    || xml.match(/<Notes>([\s\S]*?)<\/Notes>/i);
  const notes = notesMatch ? (notesMatch[1] ?? "").trim() : undefined;

  // Extract items from the active item set
  const items = parseItems(xml);

  // Extract key stats
  const stats = parseStats(xml);

  // Extract passive points from the active spec
  const passivePoints = parsePassivePoints(xml);

  return {
    game,
    className,
    ascendancy,
    level,
    mainSkill,
    skills: skills.slice(0, 10), // Limit to first 10
    notes: notes && notes.length > 0 ? notes.slice(0, 500) : undefined,
    items,
    stats,
    passivePoints,
  };
}

/**
 * Heuristic: does a string look like a PoB share code?
 * PoB codes are long (100+ chars), base64-like, often starting with eJ.
 */
export function looksLikePobCode(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 50) return false;
  // PoB codes typically start with eJ (zlib header) and are base64
  if (!/^[A-Za-z0-9+\/\-_]+=*$/.test(trimmed)) return false;
  // Must contain at least some uppercase and numbers (typical PoB codes)
  if (!/[A-Z]/.test(trimmed)) return false;
  if (!/[0-9]/.test(trimmed)) return false;
  return true;
}
