import type { OpenTuiGenerationHostSnapshot } from "../runtime/open-tui-generation-host.ts";
import { safeStartupFailure, type StartupFailure } from "../startup-failure.ts";
import { createSignal } from "solid-js";

export interface ApplicationConnectionFeedback {
  readonly session: string;
  readonly stage: string;
  readonly seconds: number;
  readonly failed: boolean;
  readonly failure?: StartupFailure;
  readonly recovery?: string;
}

/** User-visible progress accepts known fields only, never raw transport errors or credentials. */
export function createApplicationConnectionFeedback(
  onPublish: (value: ApplicationConnectionFeedback | null) => void = () => undefined,
) {
  const [snapshot, setSnapshot] = createSignal<ApplicationConnectionFeedback | null>(null);
  const publish = (value: ApplicationConnectionFeedback | null) => {
    setSnapshot(value);
    onPublish(value);
  };
  let current: ApplicationConnectionFeedback | null = null;
  let admittedSession: string | null = null;
  let hostToken = 0;
  let suppressed = false;
  let retained: { session: string; value: OpenTuiGenerationHostSnapshot } | null = null;
  let started = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const update = (stage: string, failed = false) => {
    if (!current) return;
    current = { ...current, stage, failed, seconds: Math.floor((Date.now() - started) / 1000) };
    publish(current);
  };
  const owner = {
    snapshot,
    adopt(session: string | undefined, value: OpenTuiGenerationHostSnapshot | null) {
      if (!value || value.status === "disposed") {
        admittedSession = null;
        retained = null;
        return; // A failed initial open retires its host; retain its explanation.
      }
      if (!session || (session !== admittedSession && session !== retained?.session)) return;
      retained = { session, value };
      if (suppressed || session !== admittedSession) return;
      if (value.startupFailure) {
        const failure = safeStartupFailure({ ...value.startupFailure });
        if (current?.failed && current.session === session) {
          if (JSON.stringify(current.failure) === JSON.stringify(failure)) return;
          current = null;
        }
        if (!current) {
          started = Date.now();
          current = { session, stage: "Connecting to daemon", seconds: 0, failed: false };
        }
        owner.progress(session, "startup-failed", { ...failure });
      } else if (value.status === "live" || value.status === "empty") {
        stop();
        current = null;
        publish(null);
      }
    },
    replaceOwner() {
      hostToken++;
      admittedSession = null;
      retained = null;
      suppressed = false;
      stop();
      current = null;
      publish(null);
    },
    resume() {
      if (!suppressed) return;
      suppressed = false;
      if (retained) {
        admittedSession = retained.session;
        owner.adopt(retained.session, retained.value);
      }
    },
    hostOptions(
      session: string,
      performanceEnabled: boolean,
      diagnostic: (phase: string, details: Readonly<Record<string, unknown>>) => void,
      isCurrent: () => boolean = () => true,
    ) {
      const token = ++hostToken;
      return {
        onConnectionProgress: (phase: string, details: Readonly<Record<string, unknown>>) => {
          if (token === hostToken && isCurrent()) owner.progress(session, phase, details);
        },
        ...(performanceEnabled
          ? {
              onDiagnostic: (phase: string, details: Readonly<Record<string, unknown>>) =>
                diagnostic(`generation-${phase}`, details),
            }
          : {}),
      };
    },
    text: () => {
      const value = snapshot();
      return value ? `${value.stage} · ${value.seconds}s` : null;
    },
    copy: (copyText: (text: string) => boolean | Promise<boolean>) => {
      if (!current) return;
      try {
        void Promise.resolve(copyText(JSON.stringify(current, null, 2))).catch(() => undefined);
      } catch {
        // Clipboard failure must not escape the connection controls.
      }
    },
    note(note: string | null, outcome?: "opened" | "cancelled") {
      if (outcome === "cancelled") suppressed = true;
      if (note?.startsWith("opening ")) {
        suppressed = false;
        stop();
        started = Date.now();
        admittedSession = note.slice(8);
        current = {
          session: admittedSession,
          stage: "Connecting to daemon",
          seconds: 0,
          failed: false,
        };
        publish(current);
        timer = setInterval(() => {
          if (current) update(current.stage);
        }, 1000);
      } else {
        stop();
        if (note && current && !current.failure)
          update("Could not open session — select Retry or return Home", true);
        else if (!note) {
          current = null;
          publish(null);
        }
      }
    },
    progress(session: string, phase: string, details: Readonly<Record<string, unknown>>) {
      if (suppressed || !current || current.session !== session || current.failed) return;
      if (phase === "startup-failed") {
        const failure = safeStartupFailure(details);
        const inventory = [
          "terminal-inventory-rejected",
          "invalid-runtime-proof",
          "missing-semantic-stamp",
          "invalid-semantic-stamp",
          "duplicate-semantic-stamp",
          "duplicate-runtime-pane-binding",
          "not-single-pane-window",
          "missing-window-stamp",
          "window-stamp-inconsistent",
          "duplicate-window-stamp",
        ].includes(failure.reason);
        const missing =
          failure.reason === "missing-semantic-stamp" || failure.reason === "missing-window-stamp";
        current = {
          ...current,
          failure,
          ...(inventory
            ? {
                recovery: missing
                  ? "A registered session may have been recreated. Choose that session to restore its identity, then retry here. It may be a different session."
                  : "Terminal identities conflict or cannot be verified. Copy connection details for diagnosis; Retry does not repair identity conflicts.",
              }
            : {}),
        };
        stop();
        update(
          inventory
            ? `Terminal inventory rejected: ${failure.reason}`
            : `Could not open session: ${failure.code ?? failure.reason} — select Retry or return Home`,
          true,
        );
      } else if (phase === "connection-start") update("Connecting to daemon");
      else if (phase === "connection-resolved") update("Reading terminal layout");
      else if (phase === "runtime-fault") update("Connection interrupted — retrying");
      else if (phase === "runtime-progress") {
        if (
          details.runtimePhase === "seed" &&
          Number.isSafeInteger(details.seededPanes) &&
          Number.isSafeInteger(details.expectedPanes)
        )
          update(`Receiving panes ${details.seededPanes}/${details.expectedPanes}`);
        else if (details.runtimePhase === "coherent") update("Preparing terminal view");
      }
    },
    dispose() {
      admittedSession = null;
      retained = null;
      suppressed = true;
      hostToken++;
      stop();
      current = null;
    },
  };
  return owner;
}
