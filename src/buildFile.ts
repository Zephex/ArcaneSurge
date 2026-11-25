/**
 * Minimal parser for GGG's in-game Build Planner `.build` JSON files.
 *
 * These are a different format from Path of Building share codes, so they
 * can't be uploaded to pobb.in. We extract the useful bits for a Discord reply.
 */

interface BuildSkill {
  name?: string;
  support_skills?: string[];
  additional_text?: string;
}

interface BuildSlot {
  inventory_id?: string;
  unique_name?: string;
  additional_text?: string;
}

interface BuildFile {
  name?: string;
  ascendancy?: string;
  class?: string;
  level?: number;
  passives?: unknown[];
  skills?: BuildSkill[];
  inventory_slots?: BuildSlot[];
  notes?: string;
}

export interface BuildSummary {
  name?: string;
  ascendancy?: string;
  characterClass?: string;
  level?: number;
  passiveCount: number;
  skills: string[];
  items: string[];
}

export function parseBuildFile(content: string): BuildSummary | null {
  let data: BuildFile;
  try {
    data = JSON.parse(content) as BuildFile;
  } catch {
    return null;
  }

  // A .build file should at least look like one
  if (!data || typeof data !== "object") return null;
  if (
    data.passives === undefined &&
    data.skills === undefined &&
    data.inventory_slots === undefined &&
    !data.ascendancy
  ) {
    return null;
  }

  const skills = (data.skills ?? [])
    .map((skill) => skill.name ?? skill.additional_text)
    .filter((name): name is string => typeof name === "string" && name.length > 0);

  const items = (data.inventory_slots ?? [])
    .map((slot) => {
      const name = slot.unique_name ?? slot.additional_text;
      return name && typeof name === "string" ? `${slot.inventory_id ?? "item"}: ${name}` : null;
    })
    .filter((item): item is string => item !== null);

  return {
    name: data.name,
    ascendancy: data.ascendancy,
    characterClass: data.class,
    level: data.level,
    passiveCount: Array.isArray(data.passives) ? data.passives.length : 0,
    skills: skills.slice(0, 10),
    items: items.slice(0, 10),
  };
}
