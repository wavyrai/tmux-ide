import { createSignal } from "solid-js";

export interface ApplicationConnectionFeedback {
  readonly session: string;
  readonly stage: string;
  readonly seconds: number;
  readonly failed: boolean;
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
    hostOptions(
      session: string,
      performanceEnabled: boolean,
      diagnostic: (phase: string, details: Readonly<Record<string, unknown>>) => void,
    ) {
      return {
        onConnectionProgress: (phase: string, details: Readonly<Record<string, unknown>>) =>
          owner.progress(session, phase, details),
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
    copy: (copyText: (text: string) => boolean) => {
      if (current) copyText(JSON.stringify(current, null, 2));
    },
    note(note: string | null) {
      if (note?.startsWith("opening ")) {
        stop();
        started = Date.now();
        current = {
          session: note.slice(8),
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
        if (note && current) update("Could not open session — select Retry or return Home", true);
        else {
          current = null;
          publish(null);
        }
      }
    },
    progress(session: string, phase: string, details: Readonly<Record<string, unknown>>) {
      if (!current || current.session !== session || current.failed) return;
      if (phase === "connection-start") update("Connecting to daemon");
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
      stop();
      current = null;
    },
  };
  return owner;
}
