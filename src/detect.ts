import { resolve, basename } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { writeConfig } from "./lib/yaml-io.ts";
import type { IdeConfig } from "./types.ts";

interface DetectedStack {
  packageManager: string | null;
  frameworks: string[];
  devCommand: string | null;
  language: string | null;
  reasons: string[];
}

function fileExists(dir: string, name: string): boolean {
  return existsSync(resolve(dir, name));
}

function readJson(dir: string, name: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(resolve(dir, name), "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function detectStack(dir: string): DetectedStack {
  const detected: DetectedStack = {
    packageManager: null,
    frameworks: [],
    devCommand: null,
    language: null,
    reasons: [],
  };

  // Detect package manager from lockfile
  if (fileExists(dir, "pnpm-lock.yaml")) {
    detected.packageManager = "pnpm";
    detected.reasons.push('Detected pnpm from "pnpm-lock.yaml".');
  } else if (fileExists(dir, "bun.lockb") || fileExists(dir, "bun.lock")) {
    detected.packageManager = "bun";
    detected.reasons.push('Detected bun from "bun.lockb" or "bun.lock".');
  } else if (fileExists(dir, "yarn.lock")) {
    detected.packageManager = "yarn";
    detected.reasons.push('Detected yarn from "yarn.lock".');
  } else if (fileExists(dir, "package-lock.json")) {
    detected.packageManager = "npm";
    detected.reasons.push('Detected npm from "package-lock.json".');
  }

  const pkg = readJson(dir, "package.json");
  if (pkg) {
    detected.language = "javascript";
    detected.reasons.push('Detected JavaScript from "package.json".');
    const deps = {
      ...(pkg.dependencies as Record<string, unknown> | undefined),
      ...(pkg.devDependencies as Record<string, unknown> | undefined),
    };

    if (deps["next"]) pushFramework(detected, "next", 'Found dependency "next".');
    if (deps["convex"]) pushFramework(detected, "convex", 'Found dependency "convex".');
    if (deps["vite"]) pushFramework(detected, "vite", 'Found dependency "vite".');
    if (deps["remix"] || deps["@remix-run/node"])
      pushFramework(detected, "remix", "Found Remix dependency.");
    if (deps["nuxt"]) pushFramework(detected, "nuxt", 'Found dependency "nuxt".');
    if (deps["astro"]) pushFramework(detected, "astro", 'Found dependency "astro".');
    if (deps["svelte"] || deps["@sveltejs/kit"])
      pushFramework(detected, "svelte", "Found Svelte dependency.");

    // Detect dev command
    const pm = detected.packageManager ?? "npm";
    const run = pm === "npm" ? "npm run" : pm;
    const scripts = pkg.scripts as Record<string, unknown> | undefined;
    if (scripts?.dev) {
      detected.devCommand = `${run} dev`;
      detected.reasons.push(
        `Using dev command "${detected.devCommand}" from package.json scripts.`,
      );
    } else if (scripts?.start) {
      detected.devCommand = `${run} start`;
      detected.reasons.push(
        `Using start command "${detected.devCommand}" from package.json scripts.`,
      );
    }
  }

  // Python
  if (fileExists(dir, "pyproject.toml") || fileExists(dir, "requirements.txt")) {
    detected.language = detected.language ?? "python";
    detected.reasons.push('Detected Python from "pyproject.toml" or "requirements.txt".');
    try {
      const pyproject = readFileSync(resolve(dir, "pyproject.toml"), "utf-8");
      if (pyproject.includes("fastapi"))
        pushFramework(detected, "fastapi", 'Found "fastapi" in pyproject.toml.');
      else if (pyproject.includes("django"))
        pushFramework(detected, "django", 'Found "django" in pyproject.toml.');
      else if (pyproject.includes("flask"))
        pushFramework(detected, "flask", 'Found "flask" in pyproject.toml.');
    } catch {
      // Ignore missing or unreadable pyproject metadata.
    }
  }

  // Rust
  if (fileExists(dir, "Cargo.toml")) {
    detected.language = detected.language ?? "rust";
    detected.reasons.push('Detected Rust from "Cargo.toml".');
    pushFramework(detected, "cargo", 'Using Cargo workflow from "Cargo.toml".');
  }

  // Go
  if (fileExists(dir, "go.mod")) {
    detected.language = detected.language ?? "go";
    detected.reasons.push('Detected Go from "go.mod".');
    pushFramework(detected, "go", 'Using Go workflow from "go.mod".');
  }

  // Docker
  if (fileExists(dir, "docker-compose.yml") || fileExists(dir, "docker-compose.yaml")) {
    pushFramework(
      detected,
      "docker",
      'Detected Docker from "docker-compose.yml" or "docker-compose.yaml".',
    );
  }

  if (detected.reasons.length === 0) {
    detected.reasons.push("No framework-specific signals found; using the generic layout.");
  }

  return detected;
}

export function suggestConfig(dir: string, detected: DetectedStack): IdeConfig {
  const name = basename(dir);
  const pm = detected.packageManager ?? "npm";
  const run = pm === "npm" ? "npm run" : pm;

  // Default: 2 claude panes + shell
  const config: IdeConfig = {
    name,
    rows: [
      {
        size: "70%",
        panes: [
          { title: "Claude 1", command: "claude" },
          { title: "Claude 2", command: "claude" },
        ],
      },
      {
        panes: [],
      },
    ],
  };

  const bottom = config.rows[1]!.panes;
  const frameworks = detected.frameworks;

  // Add 3rd claude pane for complex stacks
  if (frameworks.length >= 2) {
    config.rows[0]!.panes.push({ title: "Claude 3", command: "claude" });
  }

  // Add dev servers
  if (frameworks.includes("next")) {
    bottom.push({ title: "Next.js", command: `${run} dev` });
  } else if (frameworks.includes("vite")) {
    bottom.push({ title: "Vite", command: `${run} dev` });
  } else if (frameworks.includes("nuxt")) {
    bottom.push({ title: "Nuxt", command: `${run} dev` });
  } else if (frameworks.includes("remix")) {
    bottom.push({ title: "Remix", command: `${run} dev` });
  } else if (frameworks.includes("astro")) {
    bottom.push({ title: "Astro", command: `${run} dev` });
  } else if (frameworks.includes("svelte")) {
    bottom.push({ title: "SvelteKit", command: `${run} dev` });
  } else if (frameworks.includes("fastapi")) {
    bottom.push({ title: "FastAPI", command: "uvicorn main:app --reload" });
  } else if (frameworks.includes("django")) {
    bottom.push({ title: "Django", command: "python manage.py runserver" });
  } else if (frameworks.includes("flask")) {
    bottom.push({ title: "Flask", command: "flask run --reload" });
  } else if (frameworks.includes("cargo")) {
    bottom.push({ title: "Cargo", command: "cargo watch -x run" });
  } else if (frameworks.includes("go")) {
    bottom.push({ title: "Go", command: "go run ." });
  } else if (detected.devCommand) {
    bottom.push({ title: "Dev Server", command: detected.devCommand });
  }

  if (frameworks.includes("convex")) {
    bottom.push({ title: "Convex", command: "npx convex dev" });
  }

  // Always add shell
  bottom.push({ title: "Shell" });

  return config;
}

export async function detect(
  targetDir: string | undefined,
  { json, write }: { json?: boolean; write?: boolean } = {},
): Promise<void> {
  const dir = resolve(targetDir ?? ".");
  const detected = detectStack(dir);
  const suggested = suggestConfig(dir, detected);

  if (write) {
    writeConfig(dir, suggested);
    if (json) {
      console.log(JSON.stringify({ detected, suggestedConfig: suggested, written: true }, null, 2));
    } else {
      const desc =
        detected.frameworks.length > 0
          ? detected.frameworks.join(" + ")
          : (detected.language ?? "generic project");
      console.log(`Detected ${desc}. Created ide.yml.`);
      console.log("\nWhy this layout:");
      for (const reason of detected.reasons) {
        console.log(`  - ${reason}`);
      }
    }
    return;
  }

  if (json) {
    console.log(JSON.stringify({ detected, suggestedConfig: suggested }, null, 2));
    return;
  }

  console.log("Detected stack:");
  if (detected.packageManager) console.log(`  Package manager: ${detected.packageManager}`);
  if (detected.language) console.log(`  Language: ${detected.language}`);
  if (detected.frameworks.length) console.log(`  Frameworks: ${detected.frameworks.join(", ")}`);
  if (detected.devCommand) console.log(`  Dev command: ${detected.devCommand}`);
  console.log("\nReasoning:");
  for (const reason of detected.reasons) {
    console.log(`  - ${reason}`);
  }
  console.log("\nRun with --write to create ide.yml, or --json to see the suggested config.");
}

function pushFramework(detected: DetectedStack, framework: string, reason: string): void {
  if (!detected.frameworks.includes(framework)) {
    detected.frameworks.push(framework);
  }
  detected.reasons.push(reason);
}
