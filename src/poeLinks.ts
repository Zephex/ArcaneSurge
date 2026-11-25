import { decode } from "pob-parser";
import { looksLikePobCode } from "./pob.js";

export interface PoeLink {
  url: string;
}

export interface FetchedPobCode {
  code: string;
  xml: string;
}

const USER_AGENT = "ArcaneSurge-Discord-Bot/1.0 (contact: discord ArcaneSurge)";

/**
 * Find Pastebin links in a message. Other build-site links (pobb.in, etc.)
 * are deliberately ignored — the bot only reacts to pasted PoB codes and
 * Pastebin links.
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

    if (new URL(url).hostname.toLowerCase().endsWith("pastebin.com")) {
      links.push({ url });
    }
  }

  return links;
}

/** Fetch the raw PoB code behind a Pastebin link and decode it. */
export async function fetchPobCodeFromUrl(link: PoeLink): Promise<FetchedPobCode | null> {
  try {
    const idMatch = new URL(link.url).pathname.match(/^\/([A-Za-z0-9]{6,})$/);
    if (!idMatch) return null;

    const response = await fetch(`https://pastebin.com/raw/${idMatch[1]}`, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!response.ok) return null;

    const code = (await response.text()).trim();
    if (!looksLikePobCode(code)) return null;

    return { code, xml: await decode(code) };
  } catch {
    return null;
  }
}
