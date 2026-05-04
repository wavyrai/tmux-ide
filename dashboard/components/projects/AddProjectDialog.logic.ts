import type { ProjectInspect, RegisteredProject } from "@/lib/api";

/**
 * Pure logic helpers for AddProjectDialog. No React, no DOM, no fetch —
 * everything in this file is unit-testable in isolation.
 *
 * The tsx companion is rendering only; it imports the validators, state-
 * machine reducer, and parsers from here.
 */

export type AddProjectTab = "open" | "init" | "clone";

/**
 * Panel-stack flow. Each tab advances through a small set of named panels
 * — only one is rendered at a time so the dialog never overflows.
 *
 *   "pick"     — DirectoryBrowser fills the body. Footer: Cancel.
 *   "confirm"  — ProjectPreview card. Footer: Back + Add project.
 *                Used when the picked dir already has an ide.yml.
 *   "onboard"  — OnboardingWizard fills the body and owns its own footer.
 *                Used when the picked dir has no ide.yml.
 *   "init"     — Init template picker + console output. Footer: Back +
 *                Initialize / Close.
 *
 * Not every step applies to every tab — see `gotoNextAfterInspect` for the
 * branching rules.
 */
export type AddProjectStep = "pick" | "confirm" | "onboard" | "init";

export interface AddProjectFlowState {
  tab: AddProjectTab;
  step: AddProjectStep;
  /** Path the user committed via the directory browser. */
  selectedDir: string | null;
  /** Server probe result for `selectedDir`. */
  inspect: ProjectInspect | null;
}

export type FooterKind =
  | "pick"
  | "confirm"
  | "init"
  | "wizard-internal"
  | "clone";

export function defaultFlowState(tab: AddProjectTab = "open"): AddProjectFlowState {
  return { tab, step: "pick", selectedDir: null, inspect: null };
}

/** Reset to the pick panel for the active tab, clearing inspect. */
export function gotoPick(state: AddProjectFlowState): AddProjectFlowState {
  return { ...state, step: "pick", inspect: null };
}

/**
 * Switch tabs — always lands on the pick panel for the new tab and forgets
 * the prior tab's selection.
 */
export function gotoTab(
  state: AddProjectFlowState,
  tab: AddProjectTab,
): AddProjectFlowState {
  if (state.tab === tab) return state;
  return { tab, step: "pick", selectedDir: null, inspect: null };
}

/**
 * After a successful `inspectDirectory`, advance the open-tab flow:
 *
 *   - hasIdeYml         → "confirm" panel
 *   - !hasIdeYml        → "onboard" panel (wizard takes over)
 *
 * For the init tab we always advance to the "init" panel after a dir is
 * committed (no inspect required there).
 */
export function gotoNextAfterInspect(
  state: AddProjectFlowState,
  inspect: ProjectInspect,
): AddProjectFlowState {
  if (state.tab !== "open") return { ...state, inspect };
  return {
    ...state,
    inspect,
    step: inspect.hasIdeYml ? "confirm" : "onboard",
  };
}

export function commitDir(
  state: AddProjectFlowState,
  dir: string,
): AddProjectFlowState {
  // For the init tab we step to the init panel directly. Open tab waits for
  // inspect to resolve before advancing.
  if (state.tab === "init") {
    return { ...state, selectedDir: dir, step: "init" };
  }
  return { ...state, selectedDir: dir };
}

/**
 * Which footer the dialog should render. The wizard panel renders its own
 * footer — when "wizard-internal", the dialog hides its outer footer.
 */
export function activeFooterKind(state: AddProjectFlowState): FooterKind {
  if (state.tab === "clone") return "clone";
  if (state.step === "onboard") return "wizard-internal";
  if (state.step === "confirm") return "confirm";
  if (state.step === "init") return "init";
  return "pick";
}

export interface OpenTabState {
  dir: string;
  probing: boolean;
  probed: RegisteredProject | null;
  /** Reason text the UI surfaces below the input. */
  message: string | null;
}

export interface InitJobChunk {
  /** Wall-clock time the chunk arrived; useful for ordering on reconnect. */
  at: number;
  text: string;
  stream: "stdout" | "stderr" | "system";
}

export type InitJobState =
  | { kind: "idle" }
  | { kind: "running"; jobId: string; chunks: InitJobChunk[] }
  | { kind: "succeeded"; jobId: string; chunks: InitJobChunk[]; project: RegisteredProject | null }
  | { kind: "failed"; jobId: string; chunks: InitJobChunk[]; message: string };

/**
 * Trims a path, expands a leading `~` to the configured base directory,
 * and rejects empties. Doesn't probe the filesystem — the server does that.
 */
export function normalizeDir(input: string, baseDir?: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (trimmed === "~") return baseDir ?? trimmed;
  if (trimmed.startsWith("~/") && baseDir) {
    return `${baseDir.replace(/\/+$/, "")}/${trimmed.slice(2)}`;
  }
  return trimmed;
}

export interface ValidateDirResult {
  valid: boolean;
  reason: string | null;
}

export function validateDir(dir: string): ValidateDirResult {
  const trimmed = dir.trim();
  if (!trimmed) return { valid: false, reason: "Pick a project directory" };
  if (!trimmed.startsWith("/") && !trimmed.startsWith("~")) {
    return { valid: false, reason: "Use an absolute path (/foo/bar) or ~/relative" };
  }
  // Disallow obviously-bogus characters that would only get there via a
  // copy-paste mishap. Server does the real validation.
  if (/[\0\n\r]/.test(trimmed)) {
    return { valid: false, reason: "Path contains invalid characters" };
  }
  return { valid: true, reason: null };
}

export interface ValidateNameResult {
  valid: boolean;
  reason: string | null;
}

/**
 * Reject empty, whitespace-only, or duplicate names. Empty is allowed
 * (server derives a name from the dir basename) — only flag explicit
 * collisions.
 */
export function validateName(
  candidate: string | null | undefined,
  existing: ReadonlyArray<RegisteredProject>,
): ValidateNameResult {
  if (candidate === null || candidate === undefined) return { valid: true, reason: null };
  const trimmed = candidate.trim();
  if (!trimmed) return { valid: true, reason: null };
  if (!/^[a-zA-Z0-9_.-]+$/.test(trimmed)) {
    return { valid: false, reason: "Use letters, digits, dot, dash, or underscore" };
  }
  if (existing.some((p) => p.name === trimmed)) {
    return { valid: false, reason: `A project named "${trimmed}" is already registered` };
  }
  return { valid: true, reason: null };
}

/**
 * Derive a default project name from a directory path. Mirrors what the
 * server would do absent an explicit name — useful for live previews.
 */
export function deriveNameFromDir(dir: string): string {
  const trimmed = dir.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  const parts = trimmed.split("/");
  return parts[parts.length - 1] ?? "";
}

/**
 * Job state machine. The tsx component dispatches actions in response to
 * REST/WS events; this reducer owns the transitions so they're testable
 * without rendering anything.
 */
export type InitJobAction =
  | { type: "start"; jobId: string }
  | { type: "chunk"; jobId: string; chunk: InitJobChunk }
  | { type: "succeeded"; jobId: string; project: RegisteredProject | null }
  | { type: "failed"; jobId: string; message: string }
  | { type: "reset" };

export function initJobReducer(state: InitJobState, action: InitJobAction): InitJobState {
  switch (action.type) {
    case "start":
      return { kind: "running", jobId: action.jobId, chunks: [] };
    case "chunk":
      if (state.kind !== "running" || state.jobId !== action.jobId) return state;
      return { ...state, chunks: [...state.chunks, action.chunk] };
    case "succeeded":
      if (state.kind !== "running" || state.jobId !== action.jobId) return state;
      return {
        kind: "succeeded",
        jobId: state.jobId,
        chunks: state.chunks,
        project: action.project,
      };
    case "failed":
      if (state.kind !== "running" || state.jobId !== action.jobId) return state;
      return {
        kind: "failed",
        jobId: state.jobId,
        chunks: state.chunks,
        message: action.message,
      };
    case "reset":
      return { kind: "idle" };
    default:
      return state;
  }
}

/**
 * Parse a raw `init.output` WS frame chunk into the structured shape this
 * dialog stores. Trusts the server schema; defensive for the runtime case
 * where types and frames diverge.
 */
export function parseInitOutputFrame(
  frame: unknown,
  expectedJobId: string,
): InitJobChunk | null {
  if (!frame || typeof frame !== "object") return null;
  const f = frame as { jobId?: unknown; chunk?: unknown; stream?: unknown };
  if (typeof f.jobId !== "string" || f.jobId !== expectedJobId) return null;
  if (typeof f.chunk !== "string") return null;
  const stream =
    f.stream === "stderr" ? "stderr" : f.stream === "system" ? "system" : "stdout";
  return { at: Date.now(), text: f.chunk, stream };
}

export function isInitDoneFrame(
  frame: unknown,
  expectedJobId: string,
): boolean {
  if (!frame || typeof frame !== "object") return false;
  const f = frame as { type?: unknown; jobId?: unknown; done?: unknown };
  return f.type === "init.output" && f.jobId === expectedJobId && f.done === true;
}

export function isInitErrorFrame(
  frame: unknown,
  expectedJobId: string,
): { message: string } | null {
  if (!frame || typeof frame !== "object") return null;
  const f = frame as { type?: unknown; jobId?: unknown; message?: unknown };
  if (f.type !== "init.error" || f.jobId !== expectedJobId) return null;
  return { message: typeof f.message === "string" ? f.message : "Initialization failed" };
}

/**
 * Flatten the chunk list into a single console string. Used by the rendering
 * layer to feed a `<pre>`. Stable: deterministic given the same input.
 */
export function chunksToConsoleText(chunks: ReadonlyArray<InitJobChunk>): string {
  return chunks.map((c) => c.text).join("");
}

/**
 * Dialog-level UI state derived from the open/init/clone tabs. Used by the
 * tsx component to decide whether the submit button is enabled and what
 * action it should take. `kind` lets the caller render different button
 * text and dispatch a different handler:
 *
 *   - "add"     — POST /api/projects (new registration)
 *   - "open"    — already registered; just navigate to the project
 *   - "blocked" — disabled (probing, missing ide.yml, invalid dir)
 */
export interface DialogSubmitState {
  canSubmit: boolean;
  kind: "add" | "open" | "blocked";
  reason: string | null;
}

export function deriveOpenTabSubmit(input: {
  dir: string;
  probed: RegisteredProject | null;
  probing: boolean;
  existing: ReadonlyArray<RegisteredProject>;
}): DialogSubmitState {
  const dirValid = validateDir(input.dir);
  if (!dirValid.valid) return { canSubmit: false, kind: "blocked", reason: dirValid.reason };
  if (input.probing) return { canSubmit: false, kind: "blocked", reason: "Probing…" };
  if (!input.probed) {
    return { canSubmit: false, kind: "blocked", reason: "Probe the directory first" };
  }
  if (!input.probed.hasIdeYml) {
    return {
      canSubmit: false,
      kind: "blocked",
      reason: "No ide.yml found — switch to Initialize",
    };
  }
  if (input.existing.some((p) => p.name === input.probed!.name)) {
    // Already in registry — turn the disabled "Add" button into an
    // enabled "Open" button. Activating an existing project should be
    // the obvious happy path, not an error state.
    return { canSubmit: true, kind: "open", reason: null };
  }
  return { canSubmit: true, kind: "add", reason: null };
}

export function deriveInitTabSubmit(input: {
  dir: string;
  template: string | null;
  job: InitJobState;
}): DialogSubmitState {
  if (input.job.kind === "running") {
    return { canSubmit: false, kind: "blocked", reason: "Initializing…" };
  }
  if (input.job.kind === "succeeded") {
    return { canSubmit: false, kind: "blocked", reason: "Initialized" };
  }
  const dirValid = validateDir(input.dir);
  if (!dirValid.valid) return { canSubmit: false, kind: "blocked", reason: dirValid.reason };
  return { canSubmit: true, kind: "add", reason: null };
}
