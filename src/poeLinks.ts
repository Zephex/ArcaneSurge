import { fetchAndDecode, parseUrl, decode } from "pob-parser";
import { looksLikePobCode } from "./pob.js";

export type PoeLinkType = "pobb.in" | "poedb.tw" | "pob.codes" | "pastebin" | "maxroll" | "poe.ninja" | "unknown";

export interface PoeLink {
  url: string;
  type: PoeLinkType;
}

export interface FetchedPobCode {
  code: string;
  xml: string;
}

const USER_AGENT = "ArcaneSurge-Discord-Bot/1.0 (contact: discord ArcaneSurge)";

/**
 * Detect PoE-related links in a message.
 */
export function extractPoeLinks(text: string): PoeLink[] {
  const links: PoeLink[] = [];
  const seen = new Set<string>();

  const urlRegex = /https?:\/\/[^\s<>"]+/gi;
  let match: RegExpExecArray | null;

  while ((match = urlRegex.exec(text)) !== null) {
    const url = match[0].replace(/[.,;:!?)]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);

    const type = classifyUrl(url);
    if (type) {
      links.push({ url, type });
    }
  }

  return links;
}

function classifyUrl(url: string): PoeLinkType | null {
  const lower = url.toLowerCase();
  if (lower.includes("pobb.in")) return "pobb.in";
  if (lower.includes("poedb.tw") || lower.includes("poe2db.tw")) return "poedb.tw";
  if (lower.includes("pob.codes")) return "pob.codes";
  if (lower.includes("pastebin.com")) return "pastebin";
  if (lower.includes("maxroll.gg")) return "maxroll";
  if (lower.includes("poe.ninja")) return "poe.ninja";
  return null;
}

/**
 * Fetch the raw PoB share code behind a link and decode it.
 * Returns the code (for re-uploading) and the decoded XML, or null.
 */
export async function fetchPobCodeFromUrl(link: PoeLink): Promise<FetchedPobCode | null> {
  try {
    switch (link.type) {
      case "pobb.in": {
        const parsed = parseUrl(link.url);
        if (!parsed) return null;
        const response = await fetch(parsed.rawUrl, { headers: { "User-Agent": USER_AGENT } });
        if (!response.ok) return null;
        const code = (await response.text()).trim();
        return { code, xml: await decode(code) };
      }
      case "poedb.tw": {
        const idMatch = link.url.match(/\/pob\/([a-zA-Z0-9_-]+)/);
        if (!idMatch) return null;
        const response = await fetch(`https://poedb.tw/pob/${idMatch[1]}/raw`, {
          headers: { "User-Agent": USER_AGENT },
        });
        if (!response.ok) return null;
        const code = (await response.text()).trim();
        if (code.length < 10) return null;
        return { code, xml: await decode(code) };
      }
      case "pastebin": {
        const idMatch = new URL(link.url).pathname.match(/^\/([A-Za-z0-9]{6,})$/);
        if (!idMatch) return null;
        const response = await fetch(`https://pastebin.com/raw/${idMatch[1]}`, {
          headers: { "User-Agent": USER_AGENT },
        });
        if (!response.ok) return null;
        const code = (await response.text()).trim();
        if (!looksLikePobCode(code)) return null;
        return { code, xml: await decode(code) };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Get a friendly name for a PoE link type.
 */
export function linkTypeName(type: PoeLinkType): string {
  switch (type) {
    case "pobb.in": return "pobb.in";
    case "poedb.tw": return "poedb.tw";
    case "pob.codes": return "pob.codes";
    case "pastebin": return "Pastebin";
    case "maxroll": return "Maxroll";
    case "poe.ninja": return "poe.ninja";
    default: return "PoE site";
  }
}

export { fetchAndDecode };
