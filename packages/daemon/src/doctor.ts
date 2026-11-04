import { requireSupportedTmuxVersion } from "./lib/tmux-version.ts";
import { resolveTmuxExecutable } from "./lib/tmux-client-execution.ts";
import { TMUX_SOCKET_PATH_ENV } from "./lib/runtime-namespace.ts";
import { execSync, execFileSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getCurrentVersion, getUpdateStatus } from "./lib/update-check.ts";
import { installedSkillVersion } from "./lib/skill-sync.ts";
import { discoverAgents, presentAgents, type DiscoveredAgent } from "./lib/agent-discovery.ts";
import { findCompiledTui, hasDevelopmentTuiSource, isBunAvailable } from "./tui/compiled.ts";
import { claudeSettingsPath } from "./tui/integrations/claude.ts";
import { readNotificationPrefs, resolveNativeMacosNotifierPath } from "./tui/chrome/notify.ts";
import { resolveConfig } from "./lib/resolved-config.ts";
import {
  collectDaemonProvenanceReport,
  type DaemonProvenanceReport,
} from "./lib/daemon-provenance.ts";

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
      // What installing actually buys, honestly per mechanism: claude's hooks
      // give ground-truth status (and record resume ids); opencode's plugin
      // records resume ids only.
      const benefit =
        agent.capture === "hooks"
          ? "for ground-truth status"
          : "to record session ids for restore --resume-agents";
      return agent.installed
        ? { label, pass: true, detail: "integration installed ✓", optional: true }
        : {
            label,
            pass: false,
            detail: `found on PATH — run \`tmux-ide integration install ${agent.id}\` ${benefit}`,
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

/**
 * PURE — the "Claude hooks target writable" row from observed facts. Both
 * `integration install claude` and the npm postinstall write the settings
 * file; surface a permissions problem BEFORE an install fails halfway.
 * Optional: a machine without Claude Code shouldn't fail doctor over this.
 */
export function hooksTargetRow(facts: {
  settingsPath: string;
  fileExists: boolean;
  writable: boolean;
}): CheckResult {
  const label = "Claude hooks target writable";
  if (facts.writable) {
    return {
      label,
      pass: true,
      detail: facts.fileExists ? facts.settingsPath : `${facts.settingsPath} (will be created)`,
      optional: true,
    };
  }
  return {
    label,
    pass: false,
    detail: `cannot write ${facts.settingsPath} — fix its permissions (chown/chmod), or point TMUX_IDE_CLAUDE_SETTINGS at a writable path`,
    optional: true,
  };
}

/**
 * PURE — native notifier health, shown only when macOS notifications are ON.
 * Release packages always include the helper; absence means an incomplete or
 * old installation, which can still fall back to the unbranded AppleScript path.
 * Optional — informational, never fails doctor.
 */
export function notifierRow(present: boolean): CheckResult {
  const label = "native macOS notifications";
  if (present) {
    return {
      label,
      pass: true,
      detail: "bundled — branded banners and click-to-jump are ready",
      optional: true,
    };
  }
  return {
    label,
    pass: false,
    detail:
      "native helper missing — reinstall tmux-ide; unbranded AppleScript banners remain available",
    optional: true,
  };
}

/**
 * PURE — the "canonical daemon" row from a provenance report. Optional: a
 * machine without a running daemon is healthy; the row exists so triage sees
 * identity, supervisor and the real log destination without a second command.
 */
export function daemonProvenanceRow(report: DaemonProvenanceReport): CheckResult {
  const label = "canonical daemon";
  const historical = report.logFiles.filter((f) => f.status === "historical").length;
  const suffix = historical
    ? ` — ${historical} historical log file${historical === 1 ? "" : "s"} (see \`tmux-ide daemon info\`)`
    : "";
  const d = report.daemon;
  switch (report.status) {
    case "running":
      return {
        label,
        pass: true,
        detail:
          `running v${d!.productVersion} pid ${d!.pid} (${d!.supervisor ?? "unknown supervisor"}) · ` +
          `logs → ${d!.logDestination}${suffix}`,
        optional: true,
      };
    case "stale-record":
      return {
        label,
        pass: false,
        detail: `record names pid ${d!.pid} (v${d!.productVersion}) but it is not running${suffix}`,
        optional: true,
      };
    case "record-invalid":
      return {
        label,
        pass: false,
        detail: `record invalid (${report.record.status === "invalid" ? report.record.reason : "unknown"})${suffix}`,
        optional: true,
      };
    default:
      return {
        label,
        pass: true,
        detail:
          report.record.status === "reserved"
            ? `not running (reserved for supervisor ${report.record.supervisionId})${suffix}`
            : `not running${suffix}`,
        optional: true,
      };
  }
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

type TmuxProbe = (args: readonly string[]) => void;

/** Answers whether tmux knows a native command. The patched `-V` starts no server. */
function nativeCommandKnown(probe: TmuxProbe): "yes" | "no" | "no-server" | "unknown" {
  try {
    probe(["tmux-ide-resize-split", "-V"]);
    return "yes";
  } catch (error) {
    const text = String((error as { stderr?: unknown }).stderr ?? (error as Error).message);
    if (/unknown command: tmux-ide-resize-split/u.test(text)) return "no";
    return /no server running|error connecting/u.test(text) ? "no-server" : "unknown";
  }
}

/** Reads the server a session would use. With none running, a throwaway private
 * server shows what the resolved binary would start. */
export function tmuxFeaturesRow(probeServer: TmuxProbe, probeBinary: TmuxProbe): CheckResult {
  let known = nativeCommandKnown(probeServer);
  if (known === "no-server") known = nativeCommandKnown(probeBinary);
  return {
    label: "tmux features",
    pass: known !== "unknown",
    detail:
      known === "yes"
        ? "bundled tmux: full features"
        : known === "no"
          ? "stock tmux: reduced features"
          : "could not read the tmux server's features",
    optional: true,
  };
}

function runTmuxFeatureProbes(executable: string): CheckResult {
  const run =
    (prefix: readonly string[]): TmuxProbe =>
    (args) => {
      execFileSync(executable, [...prefix, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 3000,
      });
    };
  const socketPath = process.env[TMUX_SOCKET_PATH_ENV];
  const socketName = process.env.TMUX_IDE_TMUX_SOCKET_NAME;
  const server = socketPath ? ["-S", socketPath] : socketName ? ["-L", socketName] : [];
  const scratch = ["-L", `tmux-ide-doctor-${process.pid}`, "-f", "/dev/null"];
  const probeBinary: TmuxProbe = (args) => {
    run(scratch)(["new-session", "-d", "-s", "probe"]);
    try {
      run(scratch)(args);
    } finally {
      try {
        run(scratch)(["kill-server"]);
      } catch {
        // The server is already gone.
      }
    }
  };
  return tmuxFeaturesRow(run(server), probeBinary);
}

export function nodeVersionRow(version: string): CheckResult {
  const major = Number(version.split(".")[0]);
  const pass = Number.isInteger(major) && major >= 20;
  return {
    label: "Node.js ≥ 20",
    pass,
    detail: pass ? `v${version}` : `Node ${version} (need ≥ 20)`,
    optional: false,
  };
}

export async function workspaceConfigRow(projectDir: string): Promise<CheckResult> {
  try {
    const config = await resolveConfig(projectDir);
    return {
      label: "workspace config",
      pass: true,
      detail:
        config.kind === "none"
          ? "absent (optional; configless mode)"
          : config.kind === "legacy"
            ? "legacy ide.yml compatibility"
            : "found",
      optional: false,
    };
  } catch (error) {
    return {
      label: "workspace config",
      pass: false,
      detail: (error as Error).message,
      optional: false,
    };
  }
}

export async function doctor({
  json,
}: {
  json?: boolean;
} = {}): Promise<void> {
  const checks: CheckResult[] = [];

  checks.push(
    check("tmux version ≥ 3.7", () => {
      const executable = resolveTmuxExecutable();
      const version = execFileSync(executable, ["-V"], { encoding: "utf8", timeout: 3000 }).trim();
      requireSupportedTmuxVersion(version);
      return `${version} (${executable})`;
    }),
  );

  try {
    checks.push(runTmuxFeatureProbes(resolveTmuxExecutable()));
  } catch {
    // The tmux version row above already reports a missing executable.
  }

  checks.push(nodeVersionRow(process.versions.node));

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

  checks.push(await workspaceConfigRow(resolve(".")));

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
        if (checkoutEntry && hasDevelopmentTuiSource(checkoutEntry) && isBunAvailable()) {
          return "dev checkout (bun)";
        }
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

  // Optional tunnel CLIs: probe quietly (a missing binary must not leak
  // "command not found" stderr into doctor's own output) and fail with a
  // plain hint rather than execSync's raw error.
  const tunnelCli = (label: string, cmd: string): CheckResult =>
    check(
      label,
      () => {
        try {
          return execSync(cmd, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] })
            .trim()
            .split("\n")[0]!;
        } catch {
          throw new Error("not found (optional — used for remote access tunnels)");
        }
      },
      { optional: true },
    );
  checks.push(tunnelCli("tailscale CLI", "tailscale version"));
  checks.push(tunnelCli("ngrok CLI", "ngrok version"));
  checks.push(tunnelCli("cloudflared CLI", "cloudflared --version"));

  checks.push(
    (() => {
      // Claude hooks target: the settings file `integration install claude`
      // (and the npm postinstall) will write. Writability of the file itself
      // when it exists, else of its nearest existing ancestor directory.
      const settingsPath = claudeSettingsPath();
      const fileExists = existsSync(settingsPath);
      let probe = fileExists ? settingsPath : dirname(settingsPath);
      while (!existsSync(probe)) {
        const parent = dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
      let writable = false;
      try {
        accessSync(probe, constants.W_OK);
        writable = true;
      } catch {
        // leave writable=false — the row explains the fix
      }
      return hooksTargetRow({ settingsPath, fileExists, writable });
    })(),
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

  checks.push(
    check(
      "Claude Code skill",
      () => {
        // The managed skill copy under ~/.claude/skills/tmux-ide should track the
        // CLI version. Stale/missing → point at the one-command fix; installs and
        // `tmux-ide update` refresh it automatically, so this is only a nudge.
        const installed = installedSkillVersion();
        const current = getCurrentVersion();
        if (installed === null) {
          throw new Error("not installed — run `tmux-ide skill-sync`");
        }
        if (installed !== current) {
          throw new Error(`v${installed} (CLI v${current}) — run \`tmux-ide skill-sync\``);
        }
        return `in sync (v${installed})`;
      },
      { optional: true },
    ),
  );

  // Canonical daemon identity + log provenance (credential-free), so a triage
  // never chases a stale, manually redirected log file.
  checks.push(
    (() => {
      try {
        return daemonProvenanceRow(collectDaemonProvenanceReport());
      } catch (e) {
        return {
          label: "canonical daemon",
          pass: false,
          detail: `provenance unavailable: ${(e as Error).message}`,
          optional: true,
        };
      }
    })(),
  );

  // Native branded sender: only when the macOS channel is actually on.
  if (process.platform === "darwin" && readNotificationPrefs().macos) {
    checks.push(notifierRow(resolveNativeMacosNotifierPath() !== null));
  }

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
