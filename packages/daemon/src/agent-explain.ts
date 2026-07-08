/**
 * `tmux-ide agent explain <pane>` — the detection debugger.
 *
 * For a single pane it prints EVERYTHING the fleet detector reasons over:
 *   - the pane's command + pid,
 *   - the `@agent_state` authority option (raw + parsed verdict + staleness),
 *   - the `@agent_hint` override option,
 *   - which manifest resolved and via which path (hint/fast/tree),
 *   - each state's rule → matched or not (via `explain()`),
 *   - the winning instantaneous classification, and
 *   - the bottom 5 snapshot lines it judged.
 *
 * This is READ-ONLY: it captures and inspects, it never sends keys or mutates
 * the target pane.
 */
import { execFileSync } from "node:child_process";
import { explain, type DetectedState, type ManifestConfidence } from "./tui/detect/manifest.ts";
import {
  classifyInstant,
  parseAuthority,
  type AgentStatus,
  type InstantState,
} from "./tui/detect/classify.ts";
import { getManifests } from "./tui/detect/manifest-loader.ts";
import {
  describeSubtree,
  readProcessTable,
  resolveAgentCommand,
} from "./tui/detect/process-tree.ts";
import { readPaneSnapshot } from "./tui/detect/snapshot.ts";
import { IdeError } from "./lib/errors.ts";

/** Working/blocked authority reports older than this are stale (mirrors classify.ts). */
const AUTHORITY_STALE_SECONDS = 600;

interface PaneInfo {
  id: string;
  pid: number;
  cmd: string;
  title: string;
  authorityRaw: string;
  hintRaw: string;
}

export interface ExplainReport {
  pane: { id: string; cmd: string; pid: number; title: string };
  authority: {
    raw: string | null;
    state: string | null;
    epoch: number | null;
    ageSeconds: number | null;
    stale: boolean;
    verdict: AgentStatus | null;
  };
  hint: { raw: string | null; applied: boolean };
  resolution: {
    manifestId: string | null;
    matchedCommand: string;
    source: "hint" | "fast" | "tree" | "none";
    /** The matched manifest's evidence confidence (null when nothing resolved). */
    confidence: ManifestConfidence | null;
    /**
     * Executable-ish tokens seen in the pane's process subtree. Populated for
     * the "no manifest matched" case so the report can say what it DID find.
     */
    subtree: string[];
  };
  states: Array<{ state: DetectedState; matched: boolean }>;
  winner: DetectedState | null;
  instant: InstantState;
  classification: AgentStatus;
  bottomLines: string[];
}

function tmux(args: string[]): string {
  try {
    return execFileSync("tmux", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/**
 * Resolve a target to a concrete pane's fields. `%N` is a pane id; anything
 * else is treated as a session (or any tmux target) whose ACTIVE pane is used.
 */
function readPaneInfo(target: string): PaneInfo | null {
  const fmt =
    "#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{@agent_state}\t#{@agent_hint}\t#{pane_title}";
  const raw = tmux(["display-message", "-p", "-t", target, "-F", fmt]);
  if (!raw) return null;
  const [id = "", pid = "", cmd = "", authorityRaw = "", hintRaw = "", ...titleParts] =
    raw.split("\t");
  if (!id) return null;
  return {
    id,
    pid: Number(pid) || 0,
    cmd,
    authorityRaw,
    hintRaw,
    title: titleParts.join("\t"),
  };
}

/** Build the full report for a pane. Does all the io (tmux + ps + capture). */
export function buildReport(target: string): ExplainReport {
  const info = readPaneInfo(target);
  if (!info) {
    throw new IdeError(
      `No pane found for "${target}". Pass a pane id (%N) or a live session name.`,
      { code: "USAGE", exitCode: 1 },
    );
  }

  const nowSec = Math.floor(Date.now() / 1000);

  // Authority: parse richly for the report (parseAuthority collapses to a
  // verdict; here we also expose the raw state/epoch/staleness).
  const authRaw = info.authorityRaw || null;
  let authState: string | null = null;
  let authEpoch: number | null = null;
  let ageSeconds: number | null = null;
  let stale = false;
  if (authRaw) {
    const sep = authRaw.lastIndexOf(":");
    if (sep !== -1) {
      authState = authRaw.slice(0, sep);
      const epoch = Number(authRaw.slice(sep + 1));
      if (Number.isFinite(epoch)) {
        authEpoch = epoch;
        ageSeconds = nowSec - epoch;
        stale =
          (authState === "working" || authState === "blocked") &&
          ageSeconds > AUTHORITY_STALE_SECONDS;
      }
    }
  }
  const verdict = parseAuthority(info.authorityRaw, nowSec);

  // Resolution: hint > fast > tree, over the loaded (bundled + override) set.
  const manifests = getManifests();
  const table = readProcessTable();
  const resolved = resolveAgentCommand(info.cmd, info.pid, table, {
    manifests,
    hint: info.hintRaw,
  });
  const manifest = resolved.manifest;
  // When nothing resolved, record what the process-tree DID see so `explain`
  // can point the user at an `@agent_hint` target instead of a dead end.
  const subtree = manifest ? [] : describeSubtree(table, info.pid);

  // Snapshot + per-state explanation.
  const snapshot = { ...readPaneSnapshot(info.id), title: info.title };
  const explained = manifest
    ? explain(snapshot, manifest)
    : {
        state: null as DetectedState | null,
        checked: [] as Array<{ state: DetectedState; matched: boolean }>,
      };
  const instant = classifyInstant(snapshot, manifest);

  // Final classification mirrors sessions.ts: a fresh authority verdict wins;
  // otherwise the instantaneous manifest classification. (The cross-tick `done`
  // is not derivable from a single snapshot, so this is instant-only.)
  const classification: AgentStatus = verdict ?? instant;

  return {
    pane: { id: info.id, cmd: info.cmd, pid: info.pid, title: info.title },
    authority: {
      raw: authRaw,
      state: authState,
      epoch: authEpoch,
      ageSeconds,
      stale,
      verdict,
    },
    hint: { raw: info.hintRaw || null, applied: resolved.source === "hint" },
    resolution: {
      manifestId: manifest?.id ?? null,
      matchedCommand: resolved.matchedCommand,
      source: resolved.source,
      confidence: manifest ? (manifest.confidence ?? "conservative") : null,
      subtree,
    },
    states: explained.checked,
    winner: explained.state,
    instant,
    classification,
    bottomLines: snapshot.bottomNonEmpty.slice(-5),
  };
}

const STATUS_COLOR: Record<AgentStatus, string> = {
  blocked: "\x1b[31m", // red
  working: "\x1b[33m", // yellow
  done: "\x1b[32m", // green
  idle: "\x1b[36m", // cyan
  unknown: "\x1b[90m", // grey
};

/** Render the report as colored human-readable text. */
export function renderReport(r: ExplainReport, opts: { color?: boolean } = {}): string {
  const color = opts.color ?? !("NO_COLOR" in process.env);
  const c = (code: string, s: string) => (color ? `${code}${s}\x1b[0m` : s);
  const bold = (s: string) => c("\x1b[1m", s);
  const dim = (s: string) => c("\x1b[2m", s);
  const label = (s: string) => c("\x1b[36m", s);
  const status = (s: AgentStatus) => c(STATUS_COLOR[s] ?? "", s);
  const yesno = (v: boolean) => (v ? c("\x1b[32m", "yes") : dim("no"));

  const out: string[] = [];
  out.push(bold(`agent explain — ${r.pane.id}`));
  out.push(`  ${label("command")}   ${r.pane.cmd}  ${dim(`(pid ${r.pane.pid})`)}`);
  if (r.pane.title) out.push(`  ${label("title")}     ${r.pane.title}`);

  // Authority
  if (r.authority.raw) {
    const age =
      r.authority.ageSeconds !== null ? ` ${dim(`(${r.authority.ageSeconds}s ago)`)}` : "";
    const staleTag = r.authority.stale ? " " + c("\x1b[31m", "[STALE → ignored]") : "";
    const verdict = r.authority.verdict
      ? status(r.authority.verdict)
      : dim("none (stale/malformed)");
    out.push(`  ${label("authority")} ${r.authority.raw}${age}${staleTag} → ${verdict}`);
  } else {
    out.push(`  ${label("authority")} ${dim("(unset — falling back to scraping)")}`);
  }

  // Hint
  if (r.hint.raw) {
    out.push(
      `  ${label("hint")}      @agent_hint=${r.hint.raw} → ${yesno(r.hint.applied)} applied`,
    );
  } else {
    out.push(`  ${label("hint")}      ${dim("(unset)")}`);
  }

  // Resolution
  if (r.resolution.manifestId) {
    const conf =
      r.resolution.confidence === "tuned"
        ? c("\x1b[32m", "tuned")
        : dim(r.resolution.confidence ?? "conservative");
    out.push(
      `  ${label("manifest")}  ${r.resolution.manifestId}  ${dim(`via ${r.resolution.source}` + (r.resolution.matchedCommand ? ` "${r.resolution.matchedCommand}"` : ""))}  [${conf}]`,
    );
  } else {
    // No manifest matched — say so, and report what the process-tree DID see so
    // the user can set an `@agent_hint` or add a manifest.
    const saw =
      r.resolution.subtree.length > 0 ? r.resolution.subtree.join(", ") : r.pane.cmd || "(nothing)";
    out.push(`  ${label("manifest")}  ${dim("none matched")} — ${dim(`process-tree saw: ${saw}`)}`);
    out.push(`            ${dim("set `tmux set-option -p @agent_hint <agent>` to force one")}`);
  }

  // Per-state rule results
  out.push("");
  out.push(bold("  state rules"));
  if (r.states.length === 0) {
    out.push(`    ${dim("(no manifest resolved — nothing to evaluate)")}`);
  } else {
    for (const s of r.states) {
      const mark = s.matched ? c("\x1b[32m", "✓ matched") : dim("· no match");
      const win = r.winner === s.state ? "  " + c("\x1b[1m", "← winner") : "";
      out.push(`    ${s.state.padEnd(8)} ${mark}${win}`);
    }
  }

  // Final classification
  out.push("");
  out.push(
    `  ${bold("classification")}  ${status(r.classification)}  ${dim(`(instant: ${r.instant})`)}`,
  );

  // Snapshot tail
  out.push("");
  out.push(bold("  bottom 5 lines judged"));
  if (r.bottomLines.length === 0) {
    out.push(`    ${dim("(empty capture)")}`);
  } else {
    for (const line of r.bottomLines) out.push(`    ${dim("│")} ${line}`);
  }

  return out.join("\n");
}

/** CLI entry: build + print the report (human or JSON). */
export function agentExplain(target: string, opts: { json?: boolean } = {}): void {
  const report = buildReport(target);
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderReport(report));
  }
}
