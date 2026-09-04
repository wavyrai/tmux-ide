import type { OpenTuiGenerationHostSnapshot } from "./open-tui-generation-host.ts";
import type { TerminalGestureRuntimeIdentity } from "./terminal-selection.ts";
import type { ApplicationTerminalInteractionController } from "./application-terminal-interaction-controller.ts";
import type { ApplicationTerminalWorkspaceProps } from "./application-terminal-workspace.tsx";
import { randomUUID } from "node:crypto";
import { tuiPerfCriticalMark, tuiPerfDiagnostics } from "./application-performance-log.ts";
import type { PaneMenuKeyHandler } from "../workspace/pane-action-menu-model.ts";

export interface TerminalSelectionCopyEvidence {
  readonly semanticPaneId: string;
  readonly bytes: number;
  readonly start: Readonly<{ row: number; col: number }>;
  readonly end: Readonly<{ row: number; col: number }>;
}

export function terminalGestureRuntimeIdentity(
  active: OpenTuiGenerationHostSnapshot | null,
): TerminalGestureRuntimeIdentity | null {
  if (
    active?.status !== "live" ||
    !active.daemonGeneration ||
    !active.connection ||
    !active.client ||
    !active.adapter
  )
    return null;
  try {
    const clientGeneration = active.client.getSnapshot().generation;
    if (!Number.isSafeInteger(clientGeneration)) return null;
    return Object.freeze({
      daemonGeneration: active.daemonGeneration,
      clientGeneration,
      connection: active.connection,
      client: active.client,
      adapter: active.adapter,
      rendererEpoch: active.rendererEpoch,
    });
  } catch {
    return null;
  }
}

export function settleApplicationClipboardReadiness(
  readiness: Promise<boolean>,
  required: boolean,
  resolve: () => void,
  reject: (error: Error & { code?: string; boundary?: string }) => void,
): void {
  void readiness.then(
    (configured) => {
      if (!required || configured) {
        resolve();
        return;
      }
      const error = new Error("tmux clipboard policy was not ready") as Error & {
        code?: string;
        boundary?: string;
      };
      error.code = "clipboard_not_ready";
      error.boundary = "clipboard-ready";
      reject(error);
    },
    (reason) => {
      const error = new Error("tmux clipboard policy failed", { cause: reason }) as Error & {
        code?: string;
        boundary?: string;
      };
      error.code = "clipboard_not_ready";
      error.boundary = "clipboard-ready";
      reject(error);
    },
  );
}

export function applicationClipboardReadiness(
  configure: () => Promise<boolean>,
  required: boolean,
): Promise<void> {
  if (!required) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let readiness: Promise<boolean>;
    try {
      readiness = configure();
    } catch (error) {
      readiness = Promise.reject(error);
    }
    settleApplicationClipboardReadiness(readiness, true, resolve, reject);
  });
}

export function routeApplicationTerminalPointerInput(
  interaction: ApplicationTerminalInteractionController,
  paneId: string,
  input: Parameters<NonNullable<ApplicationTerminalWorkspaceProps["onTerminalInput"]>>[1],
): void {
  const routed = interaction.sendInputToPane(
    paneId,
    { kind: "text", data: input.data },
    input.kind === "application-mouse" && input.ingress
      ? {
          origin: "application-mouse",
          payload: Buffer.from(input.data),
          ingressAtMicros: input.ingress.atMicros,
          gestureId: input.ingress.gestureId,
          pointerAction: input.action,
          pointerColumn: input.column,
          pointerRow: input.row,
          pointerButton: input.button,
        }
      : undefined,
  );
  if (input.kind !== "application-mouse" || !input.ingress) {
    void routed;
    return;
  }
  const emit = (sent: boolean, outcome: "sent" | "refused" | "error") => {
    try {
      tuiPerfCriticalMark(
        `terminal-application-mouse-route:${input.ingress!.gestureId}:${input.action}`,
        "terminal-application-mouse-route",
        {
          semanticPaneId: paneId,
          gestureId: input.ingress!.gestureId,
          action: input.action,
          column: input.column,
          row: input.row,
          button: input.button,
          sent,
          outcome,
          writerHealth: tuiPerfDiagnostics(),
        },
      );
    } catch {
      // Route diagnostics never own the product input promise.
    }
  };
  void routed.then(
    (sent) => emit(sent, sent ? "sent" : "refused"),
    () => emit(false, "error"),
  );
}

export function applicationMousePointerIngressCapability<T>(
  diagnosticsEnabled: boolean,
  ingress: T,
): T | undefined {
  return diagnosticsEnabled ? ingress : undefined;
}

export function createApplicationTerminalSelectionOwner(options: {
  readonly copyText: (text: string) => boolean;
  readonly diagnosticsEnabled: boolean;
  readonly generation: () => OpenTuiGenerationHostSnapshot | null;
}) {
  let copySelection: (() => boolean) | null = null;
  let handleKey: PaneMenuKeyHandler | null = null;
  let ownsInput: (() => boolean) | undefined;
  let copyOrdinal = 0;
  let pointerGestureId: string | null = null;
  return Object.freeze({
    beginPointerIngress(input: {
      readonly action: "down" | "drag" | "move" | "up" | "wheel-up" | "wheel-down";
      readonly x: number;
      readonly y: number;
      readonly atMicros: number;
    }) {
      if (!options.diagnosticsEnabled) return null;
      try {
        if (!Number.isSafeInteger(input.atMicros) || input.atMicros < 0) return null;
        if (input.action === "down" || pointerGestureId === null) pointerGestureId = randomUUID();
        const ingress = Object.freeze({
          gestureId: pointerGestureId,
          action: input.action,
          x: input.x,
          y: input.y,
          atMicros: input.atMicros,
        });
        if (input.action === "up") pointerGestureId = null;
        return ingress;
      } catch {
        pointerGestureId = null;
        return null;
      }
    },
    copy(text: string, evidence: TerminalSelectionCopyEvidence): boolean {
      const copied = options.copyText(text);
      if (!options.diagnosticsEnabled) return copied;
      try {
        const ordinal = copyOrdinal++;
        const active = options.generation();
        const identity = active?.adapter?.paneCanonicalIdentity(evidence.semanticPaneId);
        tuiPerfCriticalMark(
          `terminal-selection-copy:${active?.rendererEpoch ?? 0}:${identity?.revision ?? -1}:${ordinal}`,
          "terminal-selection-copy",
          {
            ...evidence,
            copyOrdinal: ordinal,
            copied,
            daemonGeneration: active?.daemonGeneration ?? null,
            clientGeneration: active?.client?.getSnapshot().generation ?? null,
            rendererEpoch: active?.rendererEpoch ?? null,
            canonicalIdentity: identity,
            writerHealth: tuiPerfDiagnostics(),
          },
        );
      } catch {
        // Clipboard diagnostics never own a successful OSC52 write.
      }
      return copied;
    },
    copyCurrent: () => copySelection?.() === true,
    handleKey: (...args: Parameters<PaneMenuKeyHandler>) => handleKey?.(...args) === true,
    blocksInput: () => ownsInput?.() === true,
    registerCopy(copy: (() => boolean) | null) {
      copySelection = copy;
    },
    registerKey(next: PaneMenuKeyHandler | null, isOpen?: () => boolean) {
      handleKey = next;
      ownsInput = next ? isOpen : undefined;
    },
  });
}
