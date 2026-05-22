import { resolve, join, dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { outputError } from "./lib/output.ts";
import { loadSkills, loadSkill } from "./lib/skill-registry.ts";
import { readConfig } from "./lib/yaml-io.ts";
import { CliActionInvocationError, tryDispatchAction } from "./lib/cli-action-bridge.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

function scaffoldSkillContent(name: string): string {
  const templatePath = resolve(
    __dirname,
    "..",
    "..",
    "..",
    "templates",
    "skills",
    "general-worker.md",
  );
  if (existsSync(templatePath)) {
    return readFileSync(templatePath, "utf-8").replace(/^name: .+/m, `name: ${name}`);
  }
  return `---\nname: ${name}\nspecialties: []\nrole: teammate\ndescription: ${name} agent\n---\nYou are a ${name} agent.\n`;
}

function printSkillActionError(err: unknown): void {
  if (err instanceof CliActionInvocationError) {
    outputError(err.message, err.code.toUpperCase());
  }
  throw err;
}

async function tryDispatchSkillAction(
  dir: string,
  { json, sub, args }: { json: boolean; sub?: string; args: string[] },
): Promise<boolean> {
  try {
    if (sub === "create" && args[0]) {
      const name = args[0];
      const content = scaffoldSkillContent(name);
      const result = await tryDispatchAction("skill.create", { name, content }, { cwd: dir });
      if (!result) return false;
      const filePath = join(dir, ".tmux-ide", "skills", `${name}.md`);
      if (json) console.log(JSON.stringify({ created: true, path: filePath }));
      else console.log(`Created skill "${result.skill.name}" at ${filePath}`);
      return true;
    }

    if (sub === "update" && args[0] && args[1]) {
      const name = args[0];
      const content = readFileSync(resolve(dir, args[1]), "utf-8");
      const result = await tryDispatchAction("skill.update", { name, content }, { cwd: dir });
      if (!result) return false;
      const filePath = join(dir, ".tmux-ide", "skills", `${name}.md`);
      if (json) console.log(JSON.stringify({ updated: true, path: filePath }));
      else console.log(`Updated skill "${result.skill.name}" at ${filePath}`);
      return true;
    }

    if (sub === "delete" && args[0]) {
      const name = args[0];
      const result = await tryDispatchAction("skill.delete", { name }, { cwd: dir });
      if (!result) return false;
      if (json) console.log(JSON.stringify(result));
      else console.log(`Deleted skill "${name}"`);
      return true;
    }
  } catch (err) {
    printSkillActionError(err);
  }

  return false;
}

export async function skillCommand(
  targetDir: string | undefined,
  {
    json = false,
    sub,
    args = [],
  }: {
    json?: boolean;
    sub?: string;
    args: string[];
  },
): Promise<void> {
  const dir = resolve(targetDir ?? ".");

  if (await tryDispatchSkillAction(dir, { json, sub, args })) return;

  switch (sub) {
    case "list": {
      const skills = loadSkills(dir);
      if (json) {
        console.log(
          JSON.stringify(
            skills.map((s) => ({
              name: s.name,
              specialties: s.specialties,
              role: s.role,
              description: s.description,
            })),
            null,
            2,
          ),
        );
      } else if (skills.length === 0) {
        console.log("No skills found. Run: tmux-ide skill create <name>");
      } else {
        for (const s of skills) {
          const specs = s.specialties.length > 0 ? ` [${s.specialties.join(", ")}]` : "";
          console.log(`  ${s.name}${specs}  (${s.role}) — ${s.description}`);
        }
      }
      break;
    }
    case "show": {
      const name = args[0];
      if (!name) outputError("Usage: tmux-ide skill show <name>", "USAGE");
      const skill = loadSkill(dir, name);
      if (!skill) outputError(`Skill "${name}" not found`, "NOT_FOUND");
      if (json) {
        console.log(JSON.stringify(skill, null, 2));
      } else {
        console.log(`Skill: ${skill.name}`);
        console.log(`  Role: ${skill.role}`);
        console.log(`  Specialties: ${skill.specialties.join(", ") || "none"}`);
        console.log(`  Description: ${skill.description}`);
        if (skill.body) {
          console.log(`\n${skill.body}`);
        }
      }
      break;
    }
    case "create": {
      const name = args[0];
      if (!name) outputError("Usage: tmux-ide skill create <name>", "USAGE");
      const skillsDir = join(dir, ".tmux-ide", "skills");
      const filePath = join(skillsDir, `${name}.md`);
      if (existsSync(filePath)) {
        outputError(`Skill "${name}" already exists at ${filePath}`, "EXISTS");
      }
      const content = scaffoldSkillContent(name);
      if (!existsSync(skillsDir)) mkdirSync(skillsDir, { recursive: true });
      writeFileSync(filePath, content);
      if (json) {
        console.log(JSON.stringify({ created: true, path: filePath }));
      } else {
        console.log(`Created skill "${name}" at ${filePath}`);
      }
      break;
    }
    case "update": {
      const name = args[0];
      const contentPath = args[1];
      if (!name || !contentPath) outputError("Usage: tmux-ide skill update <name> <file>", "USAGE");
      const content = readFileSync(resolve(dir, contentPath), "utf-8");
      const skillsDir = join(dir, ".tmux-ide", "skills");
      const filePath = join(skillsDir, `${name}.md`);
      if (!existsSync(skillsDir)) mkdirSync(skillsDir, { recursive: true });
      writeFileSync(filePath, content.endsWith("\n") ? content : `${content}\n`);
      if (json) {
        console.log(JSON.stringify({ updated: true, path: filePath }));
      } else {
        console.log(`Updated skill "${name}" at ${filePath}`);
      }
      break;
    }
    case "delete": {
      const name = args[0];
      if (!name) outputError("Usage: tmux-ide skill delete <name>", "USAGE");
      const filePath = join(dir, ".tmux-ide", "skills", `${name}.md`);
      if (!existsSync(filePath)) outputError(`Skill "${name}" not found`, "NOT_FOUND");
      rmSync(filePath);
      if (json) {
        console.log(JSON.stringify({ deleted: true }));
      } else {
        console.log(`Deleted skill "${name}"`);
      }
      break;
    }
    case "validate": {
      let config;
      try {
        ({ config } = readConfig(dir));
      } catch {
        outputError("Cannot read ide.yml", "READ_ERROR");
        return;
      }
      const skills = loadSkills(dir);
      const skillNames = new Set(skills.map((s) => s.name));
      const issues: { pane: string; skill: string }[] = [];
      for (const row of config.rows) {
        for (const pane of row.panes) {
          if (pane.skill && !skillNames.has(pane.skill)) {
            issues.push({ pane: pane.title ?? "untitled", skill: pane.skill });
          }
        }
      }
      if (json) {
        console.log(JSON.stringify({ valid: issues.length === 0, unresolved: issues }, null, 2));
      } else if (issues.length === 0) {
        console.log("All pane skill references resolve.");
      } else {
        console.log(`${issues.length} unresolved skill reference(s):`);
        for (const i of issues) {
          console.log(`  pane "${i.pane}" → skill "${i.skill}" (not found)`);
        }
      }
      break;
    }
    case "help":
    case undefined:
      console.log(`Usage: tmux-ide skill <list|show|create|update|delete|validate>

  list                List all skills (project + personal)
  show <name>         Show full skill detail
  create <name>       Scaffold a new skill file
  update <name> <file> Replace a project skill from a file
  delete <name>       Delete a project skill
  validate            Check pane skill references resolve`);
      break;
    default:
      outputError(
        "Usage: tmux-ide skill <list|show|create|update|delete|validate>\nRun: tmux-ide skill help",
        "USAGE",
      );
  }
}
