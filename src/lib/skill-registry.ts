import { join } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import yaml from "js-yaml";

export interface Skill {
  name: string;
  specialties: string[];
  role: string;
  description: string;
  body: string;
}

const SKILLS_DIR = ".tmux-ide/skills";

/**
 * Parse a skill markdown file with YAML frontmatter.
 * Format: --- \n YAML \n --- \n body
 */
function parseSkillFile(content: string): Skill | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;

  try {
    const meta = yaml.load(match[1]!) as Record<string, unknown>;
    const name = (meta.name as string) ?? "";
    if (!name) return null;

    const rawSpecialties = meta.specialties;
    const specialties = Array.isArray(rawSpecialties)
      ? (rawSpecialties as string[]).map((s) => String(s).toLowerCase())
      : typeof rawSpecialties === "string"
        ? rawSpecialties.split(",").map((s) => s.trim().toLowerCase())
        : [];

    return {
      name,
      specialties,
      role: (meta.role as string) ?? "teammate",
      description: (meta.description as string) ?? "",
      body: (match[2] ?? "").trim(),
    };
  } catch {
    return null;
  }
}

/**
 * Load all skill definitions from .tmux-ide/skills/*.md
 */
export function loadSkills(dir: string): Skill[] {
  const skillsDir = join(dir, SKILLS_DIR);
  if (!existsSync(skillsDir)) return [];

  const files = readdirSync(skillsDir).filter((f) => f.endsWith(".md"));
  const skills: Skill[] = [];

  for (const file of files) {
    const content = readFileSync(join(skillsDir, file), "utf-8");
    const skill = parseSkillFile(content);
    if (skill) skills.push(skill);
  }

  return skills;
}

/**
 * Load a single skill by name.
 */
export function loadSkill(dir: string, name: string): Skill | null {
  const skills = loadSkills(dir);
  return skills.find((s) => s.name === name) ?? null;
}
