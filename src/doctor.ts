import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

interface CheckResult {
  label: string;
  pass: boolean;
  detail: string;
  optional: boolean;
}

function check(
  label: string,
  fn: () => string,
  { optional = false }: { optional?: boolean } = {},
): CheckResult {
  try {
    const result = fn();
    return { label, pass: true, detail: result, optional };
  } catch (e) {
    return { label, pass: false, detail: (e as Error).message, optional };
  }
}

export async function doctor({ json }: { json?: boolean } = {}): Promise<void> {
  const checks: CheckResult[] = [];

  checks.push(
    check("tmux installed", () => {
      execSync("which tmux", { stdio: "ignore" });
      return "found";
    }),
  );

  checks.push(
    check("tmux version ≥ 3.0", () => {
      const version = execSync("tmux -V", { encoding: "utf-8" }).trim();
      const num = parseFloat(version.replace(/[^0-9.]/g, ""));
      if (num < 3.0) throw new Error(`${version} (need ≥ 3.0)`);
      return version;
    }),
  );

  checks.push(
    check("Node.js ≥ 18", () => {
      const major = parseInt(process.versions.node.split(".")[0]!);
      if (major < 18) throw new Error(`Node ${process.versions.node} (need ≥ 18)`);
      return `v${process.versions.node}`;
    }),
  );

  checks.push(
    check(
      "256-color terminal",
      () => {
        const term = process.env.TERM ?? "";
        if (
          !term.includes("256color") &&
          !term.includes("ghostty") &&
          !term.includes("kitty") &&
          term !== "tmux-256color"
        ) {
          throw new Error(`$TERM is "${term}"`);
        }
        return term;
      },
      { optional: true },
    ),
  );

  checks.push(
    check("ide.yml exists", () => {
      const path = resolve(".", "ide.yml");
      if (!existsSync(path)) throw new Error("not found in current directory");
      return "found";
    }),
  );

  checks.push(
    check(
      "Claude Code agent teams",
      () => {
        if (process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS !== "1") {
          throw new Error("not set (enable with CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1)");
        }
        return "enabled";
      },
      { optional: true },
    ),
  );

  const allPass = checks.every((c) => c.pass || c.optional);

  if (json) {
    console.log(JSON.stringify({ ok: allPass, checks }, null, 2));
    return;
  }

  for (const c of checks) {
    const icon = c.pass ? "✓" : c.optional ? "○" : "✗";
    const color = c.pass ? "\x1b[32m" : c.optional ? "\x1b[33m" : "\x1b[31m";
    console.log(`${color}${icon}\x1b[0m ${c.label} — ${c.detail}`);
  }

  if (!allPass) process.exitCode = 1;
}
