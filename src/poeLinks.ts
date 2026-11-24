import { fetchAndDecode, parseUrl } from "pob-parser";

export type PoeLinkType = "pobb.in" | "poedb.tw" | "pob.codes" | "maxroll" | "poe.ninja" | "unknown";

export interface PoeLink {
  url: string;
  type: PoeLinkType;
}

/**
 * Detect PoE-related links in a message.
 */
export function extractPoeLinks(text: string): PoeLink[] {
  const links: PoeLink[] = [];
  const seen = new Set<string>();

  // URL regex
  const urlRegex = /https?:\/\/[^\s<>"]+/gi;
  let match: RegExpExecArray | null;

  while ((match = urlRegex.exec(text)) !== null) {
    const url = match[0].replace(/[.,;:!?)]+$/, ""); // strip trailing punctuation
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
  if (lower.includes("maxroll.gg")) return "maxroll";
  if (lower.includes("poe.ninja")) return "poe.ninja";
  return null;
}

/**
 * Try to fetch and decode a PoB code from a URL.
 * Returns the decoded XML or null if it can't be fetched/decoded.
 */
export async function fetchPobCodeFromUrl(link: PoeLink): Promise<string | null> {
  try {
    switch (link.type) {
      case "pobb.in": {
        const parsed = parseUrl(link.url);
        if (!parsed) return null;
        return await fetchAndDecode(parsed.rawUrl);
      }
      case "poedb.tw": {
        // Extract ID from URL: poedb.tw/pob/:id or poedb.tw/us/pob/:id
        const idMatch = link.url.match(/\/pob\/([a-zA-Z0-9_-]+)/);
        if (!idMatch) return null;
        const id = idMatch[1];
        const response = await fetch(`https://poedb.tw/pob/${id}/raw`, {
          headers: { "User-Agent": "ArcaneSurge-Discord-Bot/1.0 (contact: bot@arcane-surge)" },
        });
        if (!response.ok) return null;
        const code = await response.text();
        if (!code || code.length < 10) return null;
        // Decode using pob-parser
        const { decode } = await import("pob-parser");
        return await decode(code.trim());
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
    case "maxroll": return "Maxroll";
    case "poe.ninja": return "poe.ninja";
    default: return "PoE site";
  }
}
