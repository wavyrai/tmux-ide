import { currentTuiPerformanceEventSink } from "../performance-events.ts";
import {
  applicationGenerationNavigationKey,
  type createApplicationGenerationStarter,
} from "./application-generation-starter.ts";
import { createApplicationPendingTerminalInputOwner } from "./application-pending-terminal-input.ts";
import {
  sendApplicationTerminalKey,
  sendApplicationTerminalPaste,
} from "./application-terminal-paste.ts";
import type { ApplicationTerminalInteractionController } from "./application-terminal-interaction-controller.ts";
import {
  terminalInputForOpenTuiKey,
  terminalInputsForPaste,
  type OpenTuiKeyEvent,
} from "./terminal-input-adapter.ts";
import type { OpenTuiGenerationHostSnapshot } from "./open-tui-generation-host.ts";
import type { OpenTuiSessionOwner } from "./open-tui-session-owner.ts";

type GenerationStarter = ReturnType<typeof createApplicationGenerationStarter>;

/** Root-owned first-input gate for the exact session generation being opened. */
export function createApplicationTerminalInputIngress(
  interaction: ApplicationTerminalInteractionController,
  generation: () => OpenTuiGenerationHostSnapshot | null,
  sessionOwner: () => OpenTuiSessionOwner | null,
  focusedPane: () => string | null,
  setNote: (note: string | null | ((current: string | null) => string | null)) => void,
) {
  const pending = createApplicationPendingTerminalInputOwner();
  let ownsNote = false;
  type RecoveryScope = {
    owner: OpenTuiSessionOwner;
    connection: NonNullable<OpenTuiGenerationHostSnapshot["connection"]>;
    client: NonNullable<OpenTuiGenerationHostSnapshot["client"]>;
    daemon: string;
    clientGeneration: number;
    session: string;
    pane: string;
  };
  let recovery: {
    scope: RecoveryScope;
    inputs: Array<() => Promise<boolean>>;
    weight: number;
    admitted: number;
    draining: boolean;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  const scope = (): RecoveryScope | null => {
    const active = generation();
    const owner = sessionOwner();
    const pane = focusedPane();
    const session = owner?.sessionName();
    if (
      !active ||
      !["live", "rebinding"].includes(active.status) ||
      !active.connection ||
      !active.client ||
      !active.daemonGeneration ||
      !owner ||
      !session ||
      !pane
    )
      return null;
    try {
      const clientGeneration = active.client.getSnapshot().generation;
      if (!Number.isSafeInteger(clientGeneration)) return null;
      return {
        owner,
        connection: active.connection,
        client: active.client,
        daemon: active.daemonGeneration,
        clientGeneration: clientGeneration!,
        session: session!,
        pane,
      };
    } catch {
      return null;
    }
  };
  const sameScope = (left: RecoveryScope, right: RecoveryScope | null): boolean =>
    right !== null &&
    left.owner === right.owner &&
    left.connection === right.connection &&
    left.client === right.client &&
    left.daemon === right.daemon &&
    left.clientGeneration === right.clientGeneration &&
    left.session === right.session &&
    left.pane === right.pane;
  // Rejection is an outcome for this exact terminal scope, not queue occupancy.
  // Successful delivery of the admitted prefix must not hide lost input.
  let rejectedRecoveryScope: RecoveryScope | null = null;
  const rejectedRecoveryNote = "some terminal input was not sent during recovery";
  const rejectedRecoveryAdmissionNote = `terminal input queue full · ${rejectedRecoveryNote}`;
  const clearRejectedRecovery = () => {
    if (!rejectedRecoveryScope) return;
    rejectedRecoveryScope = null;
    setNote((current) =>
      current === rejectedRecoveryNote || current === rejectedRecoveryAdmissionNote
        ? null
        : current,
    );
  };
  let recoveryVersion = 0;
  const cancelRecovery = () => {
    recoveryVersion++;
    if (recovery) clearTimeout(recovery.timer);
    recovery = null;
  };
  const recover = (
    inputs: ReturnType<typeof terminalInputsForPaste>,
    bytes: Uint8Array,
    kind: "input" | "paste",
  ): boolean => {
    if (
      pending.snapshot().sessionName !== null ||
      (!recovery && generation()?.status !== "rebinding")
    )
      return false;
    const target = scope();
    if (!target) return false;
    if (rejectedRecoveryScope && !sameScope(rejectedRecoveryScope, target)) clearRejectedRecovery();
    if (recovery && !sameScope(recovery.scope, target)) cancelRecovery();
    if (!recovery) {
      const timer = setTimeout(() => {
        cancelRecovery();
        setNote("terminal recovery timed out · queued input was not sent");
      }, 5_000);
      timer.unref?.();
      recovery = { scope: target, inputs: [], weight: 0, admitted: 0, draining: false, timer };
    }
    const weight = bytes.byteLength;
    if (recovery.admitted >= 64 || recovery.weight + weight > 1024 * 1024) {
      rejectedRecoveryScope = target;
      setNote(rejectedRecoveryAdmissionNote);
      return true;
    }
    recovery.weight += weight;
    recovery.admitted++;
    const version = recoveryVersion;
    const parserOrigin = captureOrigin()
      ? {
          origin: kind === "paste" ? ("bracketed-paste" as const) : ("keyboard" as const),
          payload: Buffer.from(bytes),
        }
      : undefined;
    recovery.inputs.push(async () => {
      for (const [index, input] of inputs.entries()) {
        if (
          version !== recoveryVersion ||
          !sameScope(target, scope()) ||
          generation()?.status !== "live" ||
          !(await interaction.sendInputToPane(
            target.pane,
            input,
            index === 0 ? parserOrigin : undefined,
          ))
        )
          return false;
      }
      return true;
    });
    if (!rejectedRecoveryScope) setNote(`${target.session} · terminal ${kind} queued`);
    return true;
  };
  const flushRecovery = () => {
    const waiting = recovery;
    if (!waiting || waiting.draining) return;
    if (!sameScope(waiting.scope, scope())) {
      cancelRecovery();
      setNote("terminal changed · queued input was not sent");
      return;
    }
    if (generation()?.status !== "live" || !generation()?.fastLane) return;
    waiting.draining = true;
    const version = recoveryVersion;
    void (async () => {
      while (version === recoveryVersion && waiting.inputs.length > 0) {
        const send = waiting.inputs.shift()!;
        try {
          if (await send()) continue;
        } catch {
          /* An uncertain send is never retried. */
        }
        if (version !== recoveryVersion) return;
        cancelRecovery();
        setNote("terminal unavailable · queued input was not sent");
        return;
      }
      if (version === recoveryVersion) {
        cancelRecovery();
        if (rejectedRecoveryScope) {
          setNote((current) =>
            current === rejectedRecoveryAdmissionNote ? rejectedRecoveryNote : current,
          );
        } else setNote(null);
      }
    })();
  };
  const captureOrigin = (): boolean =>
    Boolean(currentTuiPerformanceEventSink()?.terminalInputOrigin);
  const flush = (): void => {
    const owner = sessionOwner();
    const result = pending.flush({
      sessionName: owner?.sessionName() ?? null,
      generationKey: applicationGenerationNavigationKey(owner?.snapshot() ?? null),
      focusedPane: focusedPane(),
    });
    if (result.status === "flushed" && ownsNote) {
      ownsNote = false;
      setNote(null);
    } else if (result.status === "superseded" && result.discarded > 0) {
      ownsNote = false;
      setNote("terminal changed · queued input was not sent");
    }
  };
  const noteQueued = (kind: "input" | "paste"): void => {
    ownsNote = true;
    setNote(`${pending.snapshot().sessionName} · terminal ${kind} queued`);
  };
  const noteAdmission = (
    status: "queued" | "overflow" | "unavailable",
    kind: "input" | "paste",
  ) => {
    if (status === "queued") noteQueued(kind);
    else if (status === "overflow")
      setNote("terminal input queue full · wait for the session to connect");
    else setNote(`terminal unavailable · ${kind} was not sent`);
  };

  const cancelInteractionInput = () => {
    cancelRecovery();
    clearRejectedRecovery();
    interaction.cancelPendingInput();
  };
  return {
    wrapStarter(starter: GenerationStarter): GenerationStarter {
      const start = async (...args: Parameters<GenerationStarter>) => {
        cancelInteractionInput();
        const [sessionName] = args;
        const identity = pending.begin(sessionName);
        const result = await starter(...args);
        const settlement = pending.settle(identity, result);
        if (settlement.status === "unavailable" && settlement.discarded > 0) {
          ownsNote = false;
          setNote(`${sessionName} unavailable · queued input was not sent`);
        }
        flush();
        return result;
      };
      return Object.assign(start, {
        cancel() {
          cancelInteractionInput();
          pending.dispose();
          starter.cancel();
        },
      });
    },
    adopt(terminalsActive = true): void {
      if (rejectedRecoveryScope && !sameScope(rejectedRecoveryScope, scope()))
        clearRejectedRecovery();
      if (!terminalsActive) cancelInteractionInput();
      flush();
      flushRecovery();
    },
    routeKey(event: OpenTuiKeyEvent): void {
      const active = generation();
      if (
        pending.snapshot().sessionName === null &&
        recovery === null &&
        active?.status === "live" &&
        active.fastLane &&
        focusedPane()
      ) {
        sendApplicationTerminalKey(interaction, event, captureOrigin());
        return;
      }
      const recoveryInput = terminalInputForOpenTuiKey(event);
      if (!recoveryInput) return;
      if (recover([recoveryInput], Buffer.from(recoveryInput.data, "utf8"), "input")) return;
      const copy = { name: event.name, ctrl: event.ctrl, meta: event.meta, shift: event.shift };
      noteAdmission(
        pending.enqueue(
          () => sendApplicationTerminalKey(interaction, copy, captureOrigin()),
          Buffer.byteLength(event.name, "utf8"),
        ),
        "input",
      );
    },
    routePaste(bytes: Uint8Array): void {
      if (bytes.length === 0) return;
      const copy = Uint8Array.from(bytes);
      try {
        terminalInputsForPaste(Buffer.from(copy).toString("utf8"));
      } catch {
        setNote("terminal unavailable · paste was rejected");
        return;
      }
      const active = generation();
      if (
        pending.snapshot().sessionName === null &&
        recovery === null &&
        active?.status === "live" &&
        active.fastLane &&
        focusedPane()
      ) {
        sendApplicationTerminalPaste(interaction, copy, captureOrigin());
        return;
      }
      if (recover(terminalInputsForPaste(Buffer.from(copy).toString("utf8")), copy, "paste"))
        return;
      noteAdmission(
        pending.enqueue(
          () => sendApplicationTerminalPaste(interaction, copy, captureOrigin()),
          copy.byteLength,
        ),
        "paste",
      );
    },
    dispose(): void {
      cancelInteractionInput();
      pending.dispose();
    },
  };
}
