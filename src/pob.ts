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

/** Extract a single attribute value from an XML tag. */
function attr(tag: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}="([^"]*)"`, "i");
  const m = tag.match(re);
  return m ? m[1] : undefined;
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

  return {
    game,
    className,
    ascendancy,
    level,
    mainSkill,
    skills: skills.slice(0, 10), // Limit to first 10
    notes: notes && notes.length > 0 ? notes.slice(0, 500) : undefined,
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
