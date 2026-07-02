import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getCurrentVersion, getUpdateStatus } from "./lib/update-check.ts";
import { discoverAgents, presentAgents, type DiscoveredAgent } from "./lib/agent-discovery.ts";
import { findCompiledTui, isBunAvailable } from "./tui/compiled.ts";

interface CheckResult {
  label: string;
  pass: boolean;
  detail: string;
  optional: boolean;
}

/**
 * PURE — the "agent integrations" doctor rows, one per DISCOVERED agent (absent
 * agents produce nothing — no noise). All rows are optional (informational, they
 * never fail the overall check):
 *   - `claude` + integration installed → a passing ✓ "integration installed ✓".
 *   - `claude` on PATH but NOT installed → a ○ hint pointing at the installer.
 *   - any other agent on PATH → a passing ✓ noting screen-manifest detection is
 *     active but there's no lifecycle integration yet.
 */
export function agentIntegrationRows(agents: DiscoveredAgent[]): CheckResult[] {
  return presentAgents(agents).map((agent) => {
    const label = `agent: ${agent.id}`;
    if (agent.integration) {
      return agent.installed
        ? { label, pass: true, detail: "integration installed ✓", optional: true }
        : {
            label,
            pass: false,
            detail: `found on PATH — run \`tmux-ide integration install ${agent.id}\` for ground-truth status`,
            optional: true,
          };
    }
    return {
      label,
      pass: true,
      detail: "found — screen-manifest detection active (no lifecycle integration yet)",
      optional: true,
    };
  });
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

export async function doctor({
  json,
}: {
  json?: boolean;
} = {}): Promise<void> {
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
      "TUI surfaces (cockpit / widgets)",
      () => {
        // The OpenTUI/Solid surfaces run either from a dev checkout (bun + the
        // `.tsx` sources) or, when installed, from the compiled `tmux-ide-tui`
        // binary. Report which path is live so a "nothing renders" install is
        // diagnosable instead of silent. Mirrors resolveTuiLaunch's order.
        const here = dirname(fileURLToPath(import.meta.url));
        const checkoutEntry = [
          resolve(here, "../packages/daemon/src/tui/team/index.tsx"),
          resolve(here, "tui/team/index.tsx"),
        ].find(existsSync);
        const binary = findCompiledTui();
        if (checkoutEntry && isBunAvailable()) return "dev checkout (bun)";
        if (binary) return `compiled binary (${binary})`;
        throw new Error(
          "no dev checkout+bun and no compiled binary — build one with `pnpm build:tui` or install a release that ships it",
        );
      },
      { optional: true },
    ),
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

  checks.push(
    check(
      "tailscale CLI",
      () => {
        const version = execSync("tailscale version", { encoding: "utf-8" }).trim().split("\n")[0]!;
        return version;
      },
      { optional: true },
    ),
  );

  checks.push(
    check(
      "ngrok CLI",
      () => {
        const version = execSync("ngrok version", { encoding: "utf-8" }).trim();
        return version;
      },
      { optional: true },
    ),
  );

  checks.push(
    check(
      "cloudflared CLI",
      () => {
        const version = execSync("cloudflared --version", { encoding: "utf-8" }).trim();
        return version;
      },
      { optional: true },
    ),
  );

  checks.push(
    check(
      "tmux-ide up to date",
      () => {
        const current = getCurrentVersion();
        const { latest, updateAvailable } = getUpdateStatus({ currentVersion: current });
        if (updateAvailable) {
          throw new Error(`v${current} — v${latest} available (run \`tmux-ide update\`)`);
        }
        return latest ? `v${current} (latest)` : `v${current} (latest unknown)`;
      },
      { optional: true },
    ),
  );

  // Agent integrations: one row per agent discovered on PATH (absent → no row).
  checks.push(...agentIntegrationRows(discoverAgents()));

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
