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
 * Cost control (measured on the m42 stale-pane fixture): every probe IO call is
 * a synchronous spawn on the daemon event loop, so scrape cost must never scale
 * with the number of authority-less panes per read.
 *
 *  - A fresh authority stamp skips scraping entirely, and a pane whose command
 *    resolves to no agent (or the `shell` catch-all) is classified "unknown"
 *    WITHOUT a capture round-trip.
 *  - Scrape verdicts and the shared `ps` process table are cached for
 *    {@link SCRAPE_CACHE_TTL_SECONDS}: one scrape serves every read inside the
 *    window, so a steady-state read costs a single `list-panes`.
 *  - At most {@link SCRAPE_CAPTURE_BUDGET} `capture-pane` calls fire per probe.
 *    Candidates are ordered never-scraped first, then oldest verdict first, so
 *    refresh rotates fairly across reads. A pane the budget skips reuses its
 *    previous (expired) verdict when its command is unchanged, and otherwise
 *    reports the honest `"unknown"` until a later read reaches it.
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
  /** Epoch seconds used for the authority staleness guard and the scrape-cache TTL. */
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

/**
 * How long a scrape verdict (and the shared `ps` table) keeps serving reads.
 * 2.5× the agent-status watcher cadence: reads triggered by consecutive
 * invalidation ticks reuse one scrape instead of re-spawning per read.
 */
export const SCRAPE_CACHE_TTL_SECONDS = 5;

/**
 * Maximum `capture-pane` round-trips one probe call may spend. A session full
 * of authority-less agent panes converges over a few reads instead of making
 * every read pay one spawn per pane.
 */
export const SCRAPE_CAPTURE_BUDGET = 4;

/** Cache-size ceiling; oldest verdicts evict first (pane ids are server-unique). */
const SCRAPE_CACHE_MAX_ENTRIES = 1024;

interface RawPaneOptions {
  readonly stateRaw: string | null;
  readonly statusTextRaw: string | null;
  readonly displayNameRaw: string | null;
  readonly hint: string | null;
  readonly pid: number | null;
}

interface ScrapeCacheEntry {
  readonly verdict: InstantState;
  /** The pane command the verdict was computed under; a change invalidates. */
  readonly command: string;
  readonly scrapedAtSec: number;
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
  /** Scrape verdict / process-table reuse window (default {@link SCRAPE_CACHE_TTL_SECONDS}). */
  readonly scrapeCacheTtlSeconds?: number;
  /** Per-probe `capture-pane` ceiling (default {@link SCRAPE_CAPTURE_BUDGET}). */
  readonly scrapeCaptureBudget?: number;
}

/**
 * The production probe: option gathering and pane capture BOTH go through the
 * pinned tmux runner (same socket/executable authority as attachment), while the
 * process table comes from a socket-agnostic `ps`. Never throws — a failed query
 * degrades a pane to "no facts", so the pure layer falls back cleanly.
 *
 * One probe instance serves every read of a daemon generation, so its caches
 * are shared across sessions (pane ids are server-unique).
 */
export function createTmuxAgentStatusProbe(deps: TmuxAgentStatusProbeDeps): AgentStatusProbe {
  const readProcessTable = deps.readProcessTable ?? defaultReadProcessTable;
  const capture =
    deps.capture ??
    ((runtimePaneId: string, lines: number) =>
      deps.run(["capture-pane", "-p", "-J", "-t", runtimePaneId, "-S", `-${lines}`]));
  const ttlSeconds = deps.scrapeCacheTtlSeconds ?? SCRAPE_CACHE_TTL_SECONDS;
  const captureBudget = deps.scrapeCaptureBudget ?? SCRAPE_CAPTURE_BUDGET;

  const verdictCache = new Map<string, ScrapeCacheEntry>();
  let tableCache: { readonly table: ProcEntry[]; readonly readAtSec: number } | null = null;

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

      // The `ps` read is shared across every scraped pane and across reads
      // inside the TTL window — taken at most once per probe.
      const table = (): ProcEntry[] => {
        if (tableCache === null || input.nowSec - tableCache.readAtSec > ttlSeconds) {
          tableCache = { table: readProcessTable(), readAtSec: input.nowSec };
        }
        return tableCache.table;
      };

      interface ScrapeCandidate {
        readonly pane: AgentStatusProbePane;
        readonly raw: RawPaneOptions | undefined;
        /** Prior verdict under the SAME command, possibly TTL-expired. */
        readonly priorEntry: ScrapeCacheEntry | null;
      }
      const candidates: ScrapeCandidate[] = [];
      const emit = (
        pane: AgentStatusProbePane,
        raw: RawPaneOptions | undefined,
        scrape: InstantState | null,
      ): void => {
        facts.set(pane.runtimePaneId, {
          agentStateRaw: raw?.stateRaw ?? null,
          agentStatusTextRaw: raw?.statusTextRaw ?? null,
          agentDisplayNameRaw: raw?.displayNameRaw ?? null,
          agentScrapeState: scrape,
        });
      };

      for (const pane of input.panes) {
        const raw = options.get(pane.runtimePaneId);
        const authority = parseAuthority(raw?.stateRaw ?? undefined, input.nowSec);
        if (authority !== null) {
          // Fresh authority outranks scraping — no capture, scrape state is
          // null. Drop any cached verdict so a later staleness fallback never
          // resurfaces a reading from before this authoritative report.
          verdictCache.delete(pane.runtimePaneId);
          emit(pane, raw, null);
          continue;
        }
        const cached = verdictCache.get(pane.runtimePaneId);
        const priorEntry = cached && cached.command === pane.currentCommand ? cached : null;
        if (priorEntry && input.nowSec - priorEntry.scrapedAtSec <= ttlSeconds) {
          // Fresh verdict — one scrape serves every read in the window.
          emit(pane, raw, priorEntry.verdict);
          continue;
        }
        candidates.push({ pane, raw, priorEntry });
      }

      // Never-scraped panes first (they have no status at all yet), then the
      // oldest verdicts — so bounded refresh rotates across successive reads.
      candidates.sort(
        (a, b) =>
          (a.priorEntry?.scrapedAtSec ?? Number.NEGATIVE_INFINITY) -
          (b.priorEntry?.scrapedAtSec ?? Number.NEGATIVE_INFINITY),
      );

      let capturesUsed = 0;
      for (const { pane, raw, priorEntry } of candidates) {
        // No fresh authority: resolve the real agent from the process tree, then
        // scrape only when it is a recognized agent (not shell / no match).
        const manifest = resolveAgentCommand(pane.currentCommand, raw?.pid ?? 0, table(), {
          ...(raw?.hint ? { hint: raw.hint } : {}),
          ...(deps.manifests ? { manifests: deps.manifests } : {}),
        }).manifest;
        if (!manifest || manifest.id === "shell") {
          // Free verdict (no capture) — cache it so the pane stops being a
          // candidate until the TTL lapses or its command changes.
          verdictCache.set(pane.runtimePaneId, {
            verdict: "unknown",
            command: pane.currentCommand,
            scrapedAtSec: input.nowSec,
          });
          emit(pane, raw, "unknown");
          continue;
        }
        if (capturesUsed >= captureBudget) {
          // Budget exhausted: reuse the pane's previous verdict when one exists
          // (a few seconds stale beats flapping), otherwise report the honest
          // "unknown". Nothing is cached, so the rotation reaches it next read.
          emit(pane, raw, priorEntry?.verdict ?? "unknown");
          continue;
        }
        capturesUsed += 1;
        const captured = capture(pane.runtimePaneId, SCRAPE_LINES);
        const snapshot = parseSnapshot(captured ?? "", { lines: SCRAPE_LINES });
        const verdict = classifyInstant({ ...snapshot, title: pane.title }, manifest);
        verdictCache.set(pane.runtimePaneId, {
          verdict,
          command: pane.currentCommand,
          scrapedAtSec: input.nowSec,
        });
        emit(pane, raw, verdict);
      }

      // Bound the cache: pane ids are server-unique and never re-probed after a
      // pane dies, so evict the oldest verdicts past the ceiling.
      if (verdictCache.size > SCRAPE_CACHE_MAX_ENTRIES) {
        const byAge = [...verdictCache.entries()].sort(
          (a, b) => a[1].scrapedAtSec - b[1].scrapedAtSec,
        );
        for (const [paneId] of byAge.slice(0, verdictCache.size - SCRAPE_CACHE_MAX_ENTRIES)) {
          verdictCache.delete(paneId);
        }
      }
      return facts;
    },
  };
}
