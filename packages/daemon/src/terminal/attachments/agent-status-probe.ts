/**
 * Agent-status probe for the application-shell inventory — the IO half of the
 * desktop projection's ground-truth agent detection.
 *
 * It gathers, per pane, the authoritative `@agent_state` / `@agent_status_text`
 * / `@agent_display_name` pane options and, ONLY for panes without a fresh
 * authority stamp, resolves the screen-scrape fallback (process-tree manifest
 * resolution + a `capture-pane` snapshot classified through
 * {@link classifyInstant}). The composition that turns these facts into a
 * status is pure and lives in the resource projector
 * (`resolveAgentPresentation`); this file is deliberately just the IO.
 *
 * Cost control (see CLAUDE.md "scrape fallback costs"): a fresh authority stamp
 * skips scraping entirely, and a pane whose command resolves to no agent (or the
 * `shell` catch-all) is classified "unknown" WITHOUT a capture round-trip — so
 * the expensive `ps` read happens at most once per probe and `capture-pane`
 * fires only for recognized, authority-less agent panes.
 */
import { classifyInstant, parseAuthority, type InstantState } from "../../tui/detect/classify.ts";
import type { AgentManifest } from "../../tui/detect/manifest.ts";
import {
  readProcessTable as defaultReadProcessTable,
  resolveAgentCommand,
  type ProcEntry,
} from "../../tui/detect/process-tree.ts";
import { parseSnapshot } from "../../tui/detect/snapshot.ts";

/** The per-pane facts the pure projector consumes (see `ApplicationShellPanePresentationFacts`). */
export interface AgentStatusPaneFacts {
  /** Raw `@agent_state` (`"<state>:<epoch>"`), or null when unset. */
  readonly agentStateRaw: string | null;
  /** Raw `@agent_status_text`, or null when unset. */
  readonly agentStatusTextRaw: string | null;
  /** Raw `@agent_display_name`, or null when unset. */
  readonly agentDisplayNameRaw: string | null;
  /**
   * Screen-scrape verdict, resolved only for panes WITHOUT fresh authority.
   * `null` means authority was fresh (scrape skipped).
   */
  readonly agentScrapeState: InstantState | null;
}

/** One pane the probe reasons over. */
export interface AgentStatusProbePane {
  /** Live `%N` pane id — the capture/option target (never crosses the wire). */
  readonly runtimePaneId: string;
  /** `pane_current_command` — the manifest fast-path seed. */
  readonly currentCommand: string;
  /** `pane_title` — some manifests key off it. */
  readonly title: string;
}

export interface AgentStatusProbeInput {
  /** Resolved `$N` session id — the exact `list-panes` target. */
  readonly sessionId: string;
  readonly panes: readonly AgentStatusProbePane[];
  /** Epoch seconds used for the authority staleness guard. */
  readonly nowSec: number;
}

export interface AgentStatusProbe {
  probe(input: AgentStatusProbeInput): ReadonlyMap<string, AgentStatusPaneFacts>;
}

/** Distinctive multi-char field/line delimiters — collision-resistant against option text. */
const AGENT_FIELD_SEPARATOR = "|tmux-ide-agent-field-v1|";
const AGENT_LINE_SENTINEL = "tmux-ide-agent-v1";
const AGENT_OPTIONS_FORMAT = [
  "#{pane_id}",
  "#{@agent_state}",
  "#{@agent_status_text}",
  "#{@agent_display_name}",
  "#{@agent_hint}",
  "#{pane_pid}",
  AGENT_LINE_SENTINEL,
].join(AGENT_FIELD_SEPARATOR);

/** Trailing non-empty lines captured for the scrape fallback. */
const SCRAPE_LINES = 20;

interface RawPaneOptions {
  readonly stateRaw: string | null;
  readonly statusTextRaw: string | null;
  readonly displayNameRaw: string | null;
  readonly hint: string | null;
  readonly pid: number | null;
}

const RUNTIME_PANE_ID = /^%(?:0|[1-9][0-9]*)$/u;

function emptyToNull(value: string): string | null {
  return value.length === 0 ? null : value;
}

function parseAgentOptions(stdout: string): ReadonlyMap<string, RawPaneOptions> {
  const result = new Map<string, RawPaneOptions>();
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    const fields = line.split(AGENT_FIELD_SEPARATOR);
    // paneId, state, statusText, displayName, hint, pid, sentinel
    if (fields.length !== 7 || fields[6] !== AGENT_LINE_SENTINEL) continue;
    const runtimePaneId = fields[0]!;
    if (!RUNTIME_PANE_ID.test(runtimePaneId)) continue;
    const pidText = fields[5]!;
    const pid = /^[0-9]+$/u.test(pidText) ? Number(pidText) : null;
    result.set(runtimePaneId, {
      stateRaw: emptyToNull(fields[1]!),
      statusTextRaw: emptyToNull(fields[2]!),
      displayNameRaw: emptyToNull(fields[3]!),
      hint: emptyToNull(fields[4]!),
      pid: pid !== null && Number.isSafeInteger(pid) ? pid : null,
    });
  }
  return result;
}

export interface TmuxAgentStatusProbeDeps {
  /** Pinned tmux runner: returns stdout, or null when the session is gone/unavailable. */
  readonly run: (argv: readonly string[]) => string | null;
  /** Process-table reader for the scrape fallback (default: real `ps`). */
  readonly readProcessTable?: () => ProcEntry[];
  /** Pane screen capture for the scrape fallback (default: pinned `capture-pane`). */
  readonly capture?: (runtimePaneId: string, lines: number) => string | null;
  /** Manifest set for {@link resolveAgentCommand} (default: the loaded bundled+user set). */
  readonly manifests?: AgentManifest[];
}

/**
 * The production probe: option gathering and pane capture BOTH go through the
 * pinned tmux runner (same socket/executable authority as attachment), while the
 * process table comes from a socket-agnostic `ps`. Never throws — a failed query
 * degrades a pane to "no facts", so the pure layer falls back cleanly.
 */
export function createTmuxAgentStatusProbe(deps: TmuxAgentStatusProbeDeps): AgentStatusProbe {
  const readProcessTable = deps.readProcessTable ?? defaultReadProcessTable;
  const capture =
    deps.capture ??
    ((runtimePaneId: string, lines: number) =>
      deps.run(["capture-pane", "-p", "-J", "-t", runtimePaneId, "-S", `-${lines}`]));

  return {
    probe(input): ReadonlyMap<string, AgentStatusPaneFacts> {
      const facts = new Map<string, AgentStatusPaneFacts>();
      if (input.panes.length === 0) return facts;

      const optionsStdout = deps.run([
        "list-panes",
        "-s",
        "-t",
        input.sessionId,
        "-F",
        AGENT_OPTIONS_FORMAT,
      ]);
      const options = optionsStdout === null ? new Map() : parseAgentOptions(optionsStdout);

      // The `ps` read is shared across every scraped pane and taken at most once.
      let processTable: ProcEntry[] | null = null;
      const table = (): ProcEntry[] => (processTable ??= readProcessTable());

      for (const pane of input.panes) {
        const raw = options.get(pane.runtimePaneId);
        const stateRaw = raw?.stateRaw ?? null;
        const statusTextRaw = raw?.statusTextRaw ?? null;
        const displayNameRaw = raw?.displayNameRaw ?? null;

        const authority = parseAuthority(stateRaw ?? undefined, input.nowSec);
        if (authority !== null) {
          // Fresh authority outranks scraping — no capture, scrape state is null.
          facts.set(pane.runtimePaneId, {
            agentStateRaw: stateRaw,
            agentStatusTextRaw: statusTextRaw,
            agentDisplayNameRaw: displayNameRaw,
            agentScrapeState: null,
          });
          continue;
        }

        // No fresh authority: resolve the real agent from the process tree, then
        // scrape only when it is a recognized agent (not shell / no match).
        const manifest = resolveAgentCommand(pane.currentCommand, raw?.pid ?? 0, table(), {
          ...(raw?.hint ? { hint: raw.hint } : {}),
          ...(deps.manifests ? { manifests: deps.manifests } : {}),
        }).manifest;
        let scrapeState: InstantState = "unknown";
        if (manifest && manifest.id !== "shell") {
          const captured = capture(pane.runtimePaneId, SCRAPE_LINES);
          const snapshot = parseSnapshot(captured ?? "", { lines: SCRAPE_LINES });
          scrapeState = classifyInstant({ ...snapshot, title: pane.title }, manifest);
        }
        facts.set(pane.runtimePaneId, {
          agentStateRaw: stateRaw,
          agentStatusTextRaw: statusTextRaw,
          agentDisplayNameRaw: displayNameRaw,
          agentScrapeState: scrapeState,
        });
      }
      return facts;
    },
  };
}
