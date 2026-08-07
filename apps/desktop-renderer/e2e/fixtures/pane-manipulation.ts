/**
 * A browser-to-tmux flight recorder for direct pane manipulation.
 *
 * Drag failures are otherwise almost content-free: Playwright reports the
 * element that timed out, but not whether the browser was previewing, waiting
 * for tmux, rolling back, or reconciling a confirmed layout. This probe records
 * only semantic pane identities, phases, cell counts, and geometry. It never
 * records attachment tickets, request bodies, daemon URLs, or environment
 * values.
 */
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";

import type { Page, TestInfo } from "@playwright/test";

import type { ScratchFleet } from "./scratch-fleet.ts";

export const MANIPULATION_PHASES = [
  "idle",
  "resize-preview",
  "resize-committing",
  "dragging",
  "drop-ready",
  "swap-committing",
  "rollback",
] as const;

export type ManipulationPhase = (typeof MANIPULATION_PHASES)[number];

export interface TmuxPaneGeometry {
  readonly semanticPaneId: string;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly active: boolean;
}

interface DomPaneGeometry {
  readonly semanticPaneId: string;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly dropTarget: boolean;
}

export interface ManipulationTraceEntry {
  readonly label: string;
  readonly elapsedMs: number;
  readonly phase: string;
  readonly previewCells: string | null;
  readonly confirmedCells: string | null;
  readonly panes: readonly DomPaneGeometry[];
}

interface BrowserProbeState {
  readonly startedAt: number;
  readonly entries: ManipulationTraceEntry[];
  readonly record: (label: string, phaseOverride?: string) => void;
}

interface ProbeGlobal {
  __tmuxIdePaneManipulationProbe?: BrowserProbeState;
}

const TMUX_PANE_FIELD_SEPARATOR = "__TMUX_IDE_FIELD__";
const TMUX_PANE_FORMAT = [
  "#{@tmux_ide_pane_id}",
  "#{pane_left}",
  "#{pane_top}",
  "#{pane_width}",
  "#{pane_height}",
  "#{pane_active}",
].join(TMUX_PANE_FIELD_SEPARATOR);

/** Read tmux's current-window geometry without mutating the scratch fleet. */
export function tmuxPaneGeometry(
  fleet: ScratchFleet,
  sessionName: string,
): readonly TmuxPaneGeometry[] {
  const tmuxBin = fleet.environment.TMUX_IDE_TMUX_BIN;
  if (!tmuxBin) throw new Error("the scratch fleet did not expose its tmux binary");
  const output = execFileSync(
    tmuxBin,
    ["-S", fleet.socketPath, "list-panes", "-t", `${sessionName}:`, "-F", TMUX_PANE_FORMAT],
    {
      cwd: fleet.root,
      encoding: "utf8",
      env: {
        TERM: process.env.TERM ?? "xterm-256color",
        PATH: process.env.PATH ?? "",
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    },
  );
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [semanticPaneId = "", left = "", top = "", width = "", height = "", active = ""] =
        line.split(TMUX_PANE_FIELD_SEPARATOR);
      return {
        semanticPaneId,
        left: Number(left),
        top: Number(top),
        width: Number(width),
        height: Number(height),
        active: active === "1",
      };
    })
    .sort((left, right) => left.semanticPaneId.localeCompare(right.semanticPaneId));
}

/** Stable, exact comparison form for proving cancellation did not reach tmux. */
export function tmuxLayoutSignature(panes: readonly TmuxPaneGeometry[]): string {
  return JSON.stringify(
    panes.map(({ semanticPaneId, left, top, width, height, active }) => ({
      semanticPaneId,
      left,
      top,
      width,
      height,
      active,
    })),
  );
}

export class PaneManipulationProbe {
  readonly #page: Page;
  #artifactAttached = false;

  constructor(page: Page) {
    this.#page = page;
  }

  async install(): Promise<void> {
    await this.#page.evaluate(() => {
      const global = globalThis as unknown as ProbeGlobal;
      if (global.__tmuxIdePaneManipulationProbe) return;
      const startedAt = performance.now();
      const entries: ManipulationTraceEntry[] = [];
      const record = (label: string, phaseOverride?: string): void => {
        const area = document.querySelector<HTMLElement>(".tiled-pane-area");
        const panes = [...document.querySelectorAll<HTMLElement>(".pane-tile[data-pane]")]
          .map((pane): DomPaneGeometry => {
            const rect = pane.getBoundingClientRect();
            return {
              semanticPaneId: pane.dataset.pane ?? "",
              left: Math.round(rect.left * 10) / 10,
              top: Math.round(rect.top * 10) / 10,
              width: Math.round(rect.width * 10) / 10,
              height: Math.round(rect.height * 10) / 10,
              dropTarget: pane.dataset.dropTarget === "true",
            };
          })
          .sort((left, right) => left.semanticPaneId.localeCompare(right.semanticPaneId));
        entries.push({
          label,
          elapsedMs: Math.round((performance.now() - startedAt) * 10) / 10,
          phase: phaseOverride ?? area?.dataset.manipulationPhase ?? "missing",
          previewCells: area?.dataset.manipulationPreviewCells ?? null,
          confirmedCells: area?.dataset.lastConfirmedCells ?? null,
          panes,
        });
      };
      const state: BrowserProbeState = { startedAt, entries, record };
      global.__tmuxIdePaneManipulationProbe = state;
      const observer = new MutationObserver((mutations) => {
        const names = new Set(
          mutations
            .map((mutation) => mutation.attributeName)
            .filter((name): name is string => name !== null),
        );
        const phaseMutations = mutations.filter(
          ({ attributeName }) => attributeName === "data-manipulation-phase",
        );
        for (const [index, mutation] of phaseMutations.entries()) {
          /*
           * Solid can cross a transient phase and return to idle in one task.
           * A MutationObserver then runs after BOTH writes, when reading the
           * element yields only the final value. The next record's oldValue is
           * the current record's new value, so reconstruct the exact sequence
           * rather than erasing a fast rollback/commit from the artifact.
           */
          const next = phaseMutations[index + 1];
          const phase =
            next?.target === mutation.target
              ? next.oldValue
              : (mutation.target as HTMLElement).getAttribute("data-manipulation-phase");
          record("phase-changed", phase ?? "missing");
        }
        if (names.has("data-drop-target")) record("drop-target-changed");
        if (names.has("data-manipulation-preview-cells")) record("preview-cells-changed");
        if (names.has("data-last-confirmed-cells")) record("confirmed-cells-changed");
      });
      observer.observe(document.documentElement, {
        subtree: true,
        attributes: true,
        attributeFilter: [
          "data-manipulation-phase",
          "data-drop-target",
          "data-manipulation-preview-cells",
          "data-last-confirmed-cells",
        ],
        attributeOldValue: true,
      });
      record("probe-installed");
    });
  }

  async mark(label: string): Promise<void> {
    await this.#page.evaluate((nextLabel) => {
      (globalThis as unknown as ProbeGlobal).__tmuxIdePaneManipulationProbe?.record(nextLabel);
    }, label);
  }

  async entries(): Promise<readonly ManipulationTraceEntry[]> {
    return await this.#page.evaluate(
      () =>
        (globalThis as unknown as ProbeGlobal).__tmuxIdePaneManipulationProbe?.entries.map(
          (entry) => ({ ...entry, panes: entry.panes.map((pane) => ({ ...pane })) }),
        ) ?? [],
    );
  }

  async observedPhases(): Promise<readonly string[]> {
    return [...new Set((await this.entries()).map(({ phase }) => phase))];
  }

  async previewLatencyMs(): Promise<number | null> {
    const entries = await this.entries();
    const before = [...entries].reverse().find(({ label }) => label === "before-resize-grab");
    const preview = entries.find(
      ({ phase, elapsedMs }) => phase === "resize-preview" && elapsedMs >= (before?.elapsedMs ?? 0),
    );
    return before && preview ? preview.elapsedMs - before.elapsedMs : null;
  }

  async attachArtifact(context: {
    readonly fleet: ScratchFleet;
    readonly sessionName: string;
    readonly testInfo: TestInfo;
    readonly failure?: unknown;
  }): Promise<void> {
    if (this.#artifactAttached) return;
    this.#artifactAttached = true;
    await this.mark(context.failure ? "failure-captured" : "success-captured").catch(
      () => undefined,
    );
    const trace = await this.entries().catch(() => []);
    const tmuxLayout = (() => {
      try {
        return tmuxPaneGeometry(context.fleet, context.sessionName);
      } catch (error) {
        return `layout capture failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    })();
    const paneCapture = (() => {
      try {
        // This is a disposable scratch shell created by the suite, not a user's
        // pane. Keep only the tail needed to establish input/output liveness.
        return context.fleet.capturePane(context.sessionName).slice(-2_000);
      } catch (error) {
        return `pane capture failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    })();
    const artifact = {
      result: context.failure === undefined ? "passed" : "failed",
      failure:
        context.failure instanceof Error
          ? context.failure.message
          : context.failure
            ? String(context.failure)
            : null,
      currentManipulationPhase: trace.at(-1)?.phase ?? "probe-unavailable",
      lastActiveManipulationPhase:
        [...trace].reverse().find(({ phase }) => phase !== "idle" && phase !== "missing")?.phase ??
        "none",
      acceptedPhases: MANIPULATION_PHASES,
      timingsAndDomLayouts: trace,
      tmuxLayout,
      scratchPaneCapture: paneCapture,
    };
    const path = context.testInfo.outputPath("pane-manipulation-phases.json");
    await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    await context.testInfo.attach("pane-manipulation-phases.json", {
      path,
      contentType: "application/json",
    });
    if (context.failure !== undefined) {
      const screenshot = context.testInfo.outputPath("pane-manipulation-failure.png");
      await this.#page.screenshot({ path: screenshot, fullPage: false }).catch(() => undefined);
      await context.testInfo
        .attach("pane-manipulation-failure.png", { path: screenshot, contentType: "image/png" })
        .catch(() => undefined);
    }
  }
}
