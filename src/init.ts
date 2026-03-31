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

    if (json) {
      console.log(JSON.stringify({ created: true, template, name }));
    } else {
      console.log(`Created ide.yml from "${template}" template for "${name}"`);
      const yaml = (await import("js-yaml")).default;
      printLayout(yaml.load(content) as IdeConfig);
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
    const templateSkillsDir = resolve(__dirname, "..", "templates", "skills");
    if (existsSync(templateSkillsDir)) {
      mkdirSync(skillsDir, { recursive: true });
      for (const file of readdirSync(templateSkillsDir)) {
        if (file.endsWith(".md")) {
          copyFileSync(join(templateSkillsDir, file), join(skillsDir, file));
        }
      }
      if (!json) {
        console.log("Copied built-in skill templates to .tmux-ide/skills/");
      }
    }
  }
}
