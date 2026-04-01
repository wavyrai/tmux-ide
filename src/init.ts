import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  readdirSync,
  copyFileSync,
} from "node:fs";
import { resolve, join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
import { detectStack, suggestConfig } from "./detect.ts";
import { outputError, printLayout } from "./lib/output.ts";
import type { IdeConfig } from "./types.ts";

function copyTemplateSkills(targetDir: string): string[] {
  const created: string[] = [];
  const templateSkillsDir = resolve(__dirname, "..", "templates", "skills");
  if (!existsSync(templateSkillsDir)) return created;

  mkdirSync(targetDir, { recursive: true });
  for (const file of readdirSync(templateSkillsDir)) {
    if (!file.endsWith(".md")) continue;
    const destination = join(targetDir, file);
    copyFileSync(join(templateSkillsDir, file), destination);
    created.push(destination);
  }
  return created;
}

function scaffoldLibraryStubs(dir: string): string[] {
  const created: string[] = [];
  const libraryDir = join(dir, ".tmux-ide", "library");
  if (!existsSync(libraryDir)) {
    mkdirSync(libraryDir, { recursive: true });
    created.push(libraryDir);
  }

  const archPath = join(libraryDir, "architecture.md");
  if (!existsSync(archPath)) {
    writeFileSync(
      archPath,
      "# Architecture\n\n<!-- Describe your project's architecture here. This context is injected into agent dispatch prompts. -->\n",
    );
    created.push(archPath);
  }

  const learningsPath = join(libraryDir, "learnings.md");
  if (!existsSync(learningsPath)) {
    writeFileSync(
      learningsPath,
      "# Learnings\n\n<!-- Task summaries are automatically appended here by the orchestrator. -->\n",
    );
    created.push(learningsPath);
  }

  return created;
}

function scaffoldValidationContract(dir: string): string[] {
  const created: string[] = [];
  const tasksDir = join(dir, ".tasks");
  if (!existsSync(tasksDir)) {
    mkdirSync(tasksDir, { recursive: true });
  }

  const contractPath = join(tasksDir, "validation-contract.md");
  if (!existsSync(contractPath)) {
    writeFileSync(
      contractPath,
      "# Validation Contract\n\n<!-- Define assertions that the validator agent will verify. Example: -->\n<!-- - VAL-001: All tests pass -->\n<!-- - VAL-002: No TypeScript errors -->\n<!-- - VAL-003: Lint passes with zero warnings -->\n",
    );
    created.push(contractPath);
  }

  return created;
}

function scaffoldAgentsMd(dir: string, name: string): string[] {
  const created: string[] = [];
  const agentsTemplatePath = resolve(__dirname, "..", "templates", "AGENTS.md");
  if (existsSync(agentsTemplatePath)) {
    const agentsPath = join(dir, "AGENTS.md");
    if (!existsSync(agentsPath)) {
      const content = readFileSync(agentsTemplatePath, "utf-8").replace(/{{name}}/g, name);
      writeFileSync(agentsPath, content);
      created.push(agentsPath);
    }
  }
  return created;
}

function isTeamTemplate(templateName: string): boolean {
  return templateName === "missions" || templateName.startsWith("agent-team");
}

function scaffoldTeamWorkspace(dir: string, name: string): string[] {
  const created: string[] = [];
  created.push(...scaffoldLibraryStubs(dir));
  created.push(...scaffoldValidationContract(dir));
  created.push(...scaffoldAgentsMd(dir, name));
  return created;
}

function scaffoldMissionsWorkspace(dir: string, name: string): string[] {
  const created: string[] = [];
  const skillsDir = join(dir, ".tmux-ide", "skills");
  created.push(...copyTemplateSkills(skillsDir));
  created.push(...scaffoldTeamWorkspace(dir, name));
  return created;
}

export async function init({
  template,
  json,
}: { template?: string; json?: boolean } = {}): Promise<void> {
  const dir = process.cwd();
  const configPath = resolve(dir, "ide.yml");

  if (existsSync(configPath)) {
    outputError("ide.yml already exists in this directory", "EXISTS");
  }

  // If a specific template is requested, use it
  if (template) {
    const templatePath = resolve(__dirname, "..", "templates", `${template}.yml`);
    if (!existsSync(templatePath)) {
      outputError(`Template "${template}" not found`, "NOT_FOUND");
    }

    let content = readFileSync(templatePath, "utf-8");
    const name = basename(dir);
    content = content.replace(/^name: .+/m, `name: ${name}`);
    const tmpPath = configPath + ".tmp";
    writeFileSync(tmpPath, content);
    renameSync(tmpPath, configPath);
    let created: string[];
    if (template === "missions") {
      created = scaffoldMissionsWorkspace(dir, name);
    } else if (isTeamTemplate(template)) {
      created = [
        ...copyTemplateSkills(join(dir, ".tmux-ide", "skills")),
        ...scaffoldTeamWorkspace(dir, name),
      ];
    } else {
      created = copyTemplateSkills(join(dir, ".tmux-ide", "skills"));
    }

    if (json) {
      console.log(JSON.stringify({ created: true, template, name, paths: created }));
    } else {
      console.log(`Created ide.yml from "${template}" template for "${name}"`);
      const yaml = (await import("js-yaml")).default;
      printLayout(yaml.load(content) as IdeConfig);
      for (const createdPath of created) {
        console.log(`Created ${createdPath.replace(dir + "/", "")}`);
      }
    }
    return;
  }

  // Smart detection
  const detected = detectStack(dir);
  const name = basename(dir);

  if (detected.frameworks.length > 0) {
    // Use detected stack to generate config
    const config = suggestConfig(dir, detected);
    const yaml = (await import("js-yaml")).default;
    const tmpPath2 = configPath + ".tmp";
    writeFileSync(tmpPath2, yaml.dump(config, { lineWidth: -1, noRefs: true, quotingType: '"' }));
    renameSync(tmpPath2, configPath);

    const desc = detected.frameworks.join(" + ");
    if (json) {
      console.log(JSON.stringify({ created: true, detected: detected.frameworks, name }));
    } else {
      console.log(`Detected ${desc}. Created ide.yml for "${name}".`);
      printLayout(config);
      console.log("Edit it to customize, then run: tmux-ide");
    }
  } else {
    // Fallback to default template
    const templatePath = resolve(__dirname, "..", "templates", "default.yml");
    let content = readFileSync(templatePath, "utf-8");
    content = content.replace(/^name: .+/m, `name: ${name}`);
    const tmpPath3 = configPath + ".tmp";
    writeFileSync(tmpPath3, content);
    renameSync(tmpPath3, configPath);

    if (json) {
      console.log(JSON.stringify({ created: true, template: "default", name }));
    } else {
      console.log(`Created ide.yml for "${name}"`);
      const yaml = (await import("js-yaml")).default;
      printLayout(yaml.load(content) as IdeConfig);
      console.log("Edit it to configure your workspace, then run: tmux-ide");
    }
  }

  // Copy built-in skills if .tmux-ide/skills/ doesn't exist
  const skillsDir = join(dir, ".tmux-ide", "skills");
  if (!existsSync(skillsDir)) {
    const created = copyTemplateSkills(skillsDir);
    if (created.length > 0 && !json) {
      console.log("Copied built-in skill templates to .tmux-ide/skills/");
    }
  }
}
