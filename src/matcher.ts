import type { Entry } from "./config.js";

export interface CompiledTrigger {
  entry: Entry;
  /** The trigger exactly as written in the config. */
  trigger: string;
  pattern: RegExp;
  /** True when the pattern must run against the normalised message. */
  onNormalised: boolean;
  /** Higher wins when several triggers match; ties go to config order. */
  specificity: number;
}

export interface Match {
  entry: Entry;
  trigger: string;
}

/**
 * Lowercase, replace punctuation with spaces, collapse whitespace.
 * "How do I get verified?" -> "how do i get verified"
 */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `/pattern/flags` triggers are matched literally against the raw message. */
const REGEX_TRIGGER = /^\/(.+)\/([a-z]*)$/;

/** Punctuation that carries no meaning in a trigger. */
const INERT_PUNCTUATION = /[?!.,;:'"’”‘“()[\]{}…\-–—\s]/gu;

function compile(trigger: string, entry: Entry): CompiledTrigger {
  const trimmed = trigger.trim();
  const literal = REGEX_TRIGGER.exec(trimmed);

  if (literal) {
    const [, source = "", rawFlags = ""] = literal;
    const flags = rawFlags.replace(/g/g, ""); // /g makes .test() stateful
    return {
      entry,
      trigger: trimmed,
      pattern: new RegExp(source, flags.includes("i") ? flags : `${flags}i`),
      onNormalised: false,
      specificity: trimmed.length,
    };
  }

  const phrase = normalise(trimmed);
  if (!phrase) {
    throw new Error(
      `trigger "${trigger}" (entry "${entry.id}") is empty after normalisation`,
    );
  }

  // Warn when symbols were stripped: "C#" -> "c" would match any lone "c".
  const residual = trimmed.replace(INERT_PUNCTUATION, "");
  if (/[^\p{L}\p{N}]/u.test(residual)) {
    const tokens = phrase.split(" ");
    if (tokens.length === 1 && phrase.length <= 2) {
      throw new Error(
        `trigger "${trigger}" (entry "${entry.id}") reduces to "${phrase}", ` +
          `which would match any standalone "${phrase}". ` +
          `Use a regex trigger instead, e.g. "/${trimmed}/i".`,
      );
    }
    console.warn(
      `[faq] trigger "${trigger}" (entry "${entry.id}"): symbols are stripped during ` +
        `matching, so it will match "${phrase}". Use a /regex/ trigger for literal symbols.`,
    );
  }

  const body = escapeRegExp(phrase).replace(/\s+/g, "\\s+");
  return {
    entry,
    trigger: trimmed,
    pattern: new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "u"),
    onNormalised: true,
    specificity: phrase.length,
  };
}

export function compileTriggers(entries: Entry[]): CompiledTrigger[] {
  return entries.flatMap((entry) => entry.triggers.map((trigger) => compile(trigger, entry)));
}

/**
 * Find the entry that matches `message`.
 *
 * Phrases are normalised on both sides and bounded by word boundaries, so
 * "rules" matches "safety rules" but not "safetyrules". When several
 * triggers match, the longest one wins so specific phrases beat short ones.
 */
export function findMatch(triggers: CompiledTrigger[], message: string): Match | null {
  const trimmed = message.trim();
  if (!trimmed) return null;
  const normalised = normalise(trimmed);
  if (!normalised) return null;

  let best: CompiledTrigger | null = null;
  for (const candidate of triggers) {
    const subject = candidate.onNormalised ? normalised : trimmed;
    if (!candidate.pattern.test(subject)) continue;
    if (best === null || candidate.specificity > best.specificity) best = candidate;
  }

  return best ? { entry: best.entry, trigger: best.trigger } : null;
}
