import { join } from "node:path";
import { homedir } from "node:os";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import yaml from "js-yaml";

export interface Skill {
  name: string;
  specialties: string[];
  role: string;
  description: string;
  body: string;
}

const SKILLS_DIR = ".tmux-ide/skills";
const SAFE_SKILL_NAME = /^[A-Za-z0-9._ -]+$/;

/**
 * Parse a skill markdown file with YAML frontmatter.
 * Format: --- \n YAML \n --- \n body
 */
export function parseSkillFile(content: string): Skill | null {
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

function loadSkillsFromDir(skillsDir: string): Skill[] {
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
 * Load all skill definitions from .tmux-ide/skills/*.md (project)
 * and ~/.tmux-ide/skills/*.md (personal). Project skills take precedence.
 */
export function loadSkills(dir: string): Skill[] {
  const projectSkills = loadSkillsFromDir(join(dir, SKILLS_DIR));
  const personalDir = join(homedir(), SKILLS_DIR);
  const personalSkills = loadSkillsFromDir(personalDir);

  // Project skills take precedence over personal skills by name
  const nameSet = new Set(projectSkills.map((s) => s.name));
  for (const ps of personalSkills) {
    if (!nameSet.has(ps.name)) {
      projectSkills.push(ps);
    }
  }

  return projectSkills;
}

/**
 * Load a single skill by name.
 */
export function loadSkill(dir: string, name: string): Skill | null {
  const skills = loadSkills(dir);
  return skills.find((s) => s.name === name) ?? null;
}

function assertSafeSkillName(name: string): void {
  if (!name.trim() || !SAFE_SKILL_NAME.test(name) || name.includes("..") || name.includes("/")) {
    throw new Error(`Invalid skill name "${name}"`);
  }
}

function projectSkillPath(dir: string, name: string): string {
  assertSafeSkillName(name);
  return join(dir, SKILLS_DIR, `${name}.md`);
}

export function saveSkill(dir: string, name: string, content: string): Skill {
  const parsed = parseSkillFile(content);
  if (!parsed) {
    throw new Error("Skill content must include valid YAML frontmatter with a name");
  }
  if (parsed.name !== name) {
    throw new Error(`Skill frontmatter name "${parsed.name}" does not match "${name}"`);
  }

  const path = projectSkillPath(dir, name);
  mkdirSync(join(dir, SKILLS_DIR), { recursive: true });
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, content.endsWith("\n") ? content : `${content}\n`);
  renameSync(tmpPath, path);

  const saved = parseSkillFile(readFileSync(path, "utf-8"));
  if (!saved) {
    throw new Error(`Saved skill "${name}" could not be parsed`);
  }
  return saved;
}

export function deleteSkill(dir: string, name: string): boolean {
  const path = projectSkillPath(dir, name);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

/**
 * Write a skill from structured fields. Builds the YAML frontmatter
 * for the host so UI surfaces don't have to hand-roll markdown.
 */
export interface SkillFields {
  name: string;
  specialties?: string[];
  role?: string;
  description?: string;
  body?: string;
}

export function projectSkillExists(dir: string, name: string): boolean {
  return existsSync(projectSkillPath(dir, name));
}

export function writeSkillFromFields(dir: string, fields: SkillFields): Skill {
  const specialties = (fields.specialties ?? []).map((s) => s.trim()).filter(Boolean);
  const meta: Record<string, unknown> = {
    name: fields.name,
    specialties,
    role: fields.role && fields.role.trim() ? fields.role.trim() : "teammate",
    description: fields.description ?? "",
  };
  const yamlBlock = yaml.dump(meta, { lineWidth: 1000 }).trimEnd();
  const body = (fields.body ?? "").replace(/^\n+/, "").replace(/\n+$/, "");
  const content = `---\n${yamlBlock}\n---\n${body ? `\n${body}\n` : ""}`;
  return saveSkill(dir, fields.name, content);
}
