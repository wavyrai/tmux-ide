import { createHash, randomUUID } from "node:crypto";
import type { Accessor, Setter } from "solid-js";
import type { SessionRuntimeTerminalInput } from "@tmux-ide/contracts";
import {
  currentTuiPerformanceEventSink,
  type TuiTerminalInputOrigin,
  type TuiTerminalInputTrace,
} from "../performance-events.ts";
import {
  type OpenTuiWorkspaceLayout,
  type OpenTuiWorkspaceLayoutSnapshot,
} from "../open-tui-workspace-runtime-port.ts";
import type { ApplicationPaneResizePreview } from "./application-terminal-workspace.tsx";
import { prepareCausalCellFixtureV1 } from "./causal-cell-input-fixture.ts";
import type { OpenTuiGenerationHostSnapshot } from "./open-tui-generation-host.ts";
import { selectTerminalPane, type LivePaneSelectionTarget } from "./select-terminal-pane.ts";
import type { PaneSelectionFailure } from "./select-terminal-pane.ts";
import { TerminalPaneInputRouter } from "./terminal-pane-input-router.ts";

type DiagnosticSink = (phase: string, details?: Readonly<Record<string, unknown>>) => void;

interface DiagnosticWindowFrameContext {
  readonly kind: "window-switch" | "window-rename";
  readonly traceId: string;
  readonly target: string;
  readonly paneId: string;
  readonly startedAtMicros: number;
  readonly daemonGeneration: string;
  readonly clientGeneration: number;
  readonly rendererEpoch: number;
  readonly sourceEpoch: number;
  readonly generation: string;
  readonly incarnation: string;
  readonly revision: number;
  readonly stateHash: string;
  readonly cols: number;
  readonly rows: number;
}

export interface ApplicationTerminalInteractionControllerOptions {
  readonly generation: Accessor<OpenTuiGenerationHostSnapshot | null>;
  readonly layout: Accessor<OpenTuiWorkspaceLayoutSnapshot>;
  readonly focusedPane?: Accessor<string | null>;
  readonly rendererFocused?: Accessor<boolean>;
  readonly shellPresentation?: Accessor<readonly (string | number | boolean | null)[] | null>;
  readonly setFocusedPane: Setter<string | null>;
  readonly diagnosticsEnabled: boolean;
  /** Gates all per-stage window timing clocks and records in detailed traces. */
  readonly detailedWindowSwitchTiming?: boolean;
  readonly diagnose: DiagnosticSink;
  readonly diagnoseCritical?: (
    key: string,
    phase: string,
    details?: Readonly<Record<string, unknown>>,
  ) => boolean;
  readonly diagnosticHealth?: () => Readonly<{
    droppedRecords: number;
    failed: boolean;
    pendingCriticalRecords: number;
  }>;
  readonly createTraceId?: () => string;
  readonly nowMicros?: () => number;
  readonly causalCellFixtureEnabled?: () => boolean;
  readonly requestRender?: () => void;
}

export interface ApplicationTerminalInteractionController {
  adoptGeneration(snapshot: OpenTuiGenerationHostSnapshot | null): void;
  adoptLayout(snapshot: OpenTuiWorkspaceLayoutSnapshot): void;
  selectPane(paneId: string): void;
  sendInput(
    input: SessionRuntimeTerminalInput,
    parserOrigin?: Pick<TuiTerminalInputOrigin, "origin" | "payload">,
  ): Promise<void>;
  previewPaneResize(preview: ApplicationPaneResizePreview): void;
  resizePane(preview: ApplicationPaneResizePreview): void;
  cycleWindow(): void;
  observeWindowPresentation(semanticWindowId: string, paneId: string, windowName?: string): void;
  observeDiagnosticWindowFrame():
    | import("../performance-events.ts").TuiWindowPresentationFrameEvidence
    | null;
  settleWindowSwitchFrame(): void;
  settleResizeGuideFrame(): void;
}

function paneForWindow(layout: OpenTuiWorkspaceLayout): string | null {
  return (
    layout.panes.find((pane) => pane.active && pane.pane)?.pane ??
    layout.panes.find((pane) => pane.pane)?.pane ??
    null
  );
}

/** Owns terminal interaction state; the Solid root only binds its methods. */
export function createApplicationTerminalInteractionController(
  options: ApplicationTerminalInteractionControllerOptions,
): ApplicationTerminalInteractionController {
  const createTraceId = options.createTraceId ?? randomUUID;
  const nowMicros = options.nowMicros ?? (() => Math.floor(performance.now() * 1_000));
  const diagnosticNowMicros = (): number | null => {
    try {
      const value = nowMicros();
      return Number.isSafeInteger(value) && value >= 0 ? value : null;
    } catch {
      return null;
    }
  };
  const causalCellFixtureEnabled =
    options.causalCellFixtureEnabled ?? (() => process.env.TMUX_IDE_CAUSAL_CELL_FIXTURE === "1");
  const diagnose = (phase: string, details?: Readonly<Record<string, unknown>>): void => {
    try {
      options.diagnose(phase, details);
    } catch {
      // Diagnostics never own semantic interaction or renderer publication.
    }
  };
  const diagnoseCritical = (
    key: string,
    phase: string,
    details?: Readonly<Record<string, unknown>>,
  ): void => {
    try {
      if (options.diagnoseCritical) options.diagnoseCritical(key, phase, details);
      else diagnose(phase, details);
    } catch {
      // Critical diagnostic retention still cannot own semantic interaction.
    }
  };
  let pendingWindowSwitch: {
    readonly traceId: string;
    readonly target: string;
    readonly paneId: string;
    readonly startedAtMicros: number;
    readonly daemonGeneration: string;
    readonly clientGeneration: number;
    readonly rendererEpoch: number;
    readonly sourceEpoch: number;
    readonly generation: string;
    readonly incarnation: string;
    readonly revision: number;
    readonly stateHash: string;
    readonly cols: number;
    readonly rows: number;
    layoutPublished: boolean;
    selectionApplied: boolean;
    presentationPublished: boolean;
    followUpRequested: boolean;
    timing?: {
      receiptAtMicros: number | null;
      layoutAtMicros: number | null;
      presentationAtMicros: number | null;
    };
  } | null = null;
  let pendingWindowRename: {
    readonly traceId: string;
    readonly target: string;
    readonly paneId: string;
    readonly previousName: string;
    readonly windowName: string;
    readonly startedAtMicros: number;
    readonly daemonGeneration: string;
    readonly clientGeneration: number;
    readonly rendererEpoch: number;
    readonly sourceEpoch: number;
    readonly generation: string;
    readonly incarnation: string;
    readonly revision: number;
    readonly stateHash: string;
    readonly cols: number;
    readonly rows: number;
    presentationPublished: boolean;
    followUpRequested: boolean;
  } | null = null;
  let previousCurrentWindow: {
    readonly target: string;
    readonly paneId: string;
    readonly name: string;
  } | null = null;
  let pendingResizeGuide: { readonly traceId: string; readonly startedAtMicros: number } | null =
    null;
  let lastWindowPresentationDigest: string | null = null;
  let diagnosticWindowFrame: DiagnosticWindowFrameContext | null = null;
  let diagnosticWindowFrameExpiresAtMicros = 0;
  let inputAuthorityIdentity: Readonly<{
    daemonGeneration: string;
    clientGeneration: number;
    rendererEpoch: number;
    connection: NonNullable<OpenTuiGenerationHostSnapshot["connection"]>;
    client: NonNullable<OpenTuiGenerationHostSnapshot["client"]>;
    fastLane: NonNullable<OpenTuiGenerationHostSnapshot["fastLane"]>;
    adapter: NonNullable<OpenTuiGenerationHostSnapshot["adapter"]>;
  }> | null = null;

  const armDiagnosticWindowFrame = (pending: DiagnosticWindowFrameContext): void => {
    diagnosticWindowFrame = pending;
    diagnosticWindowFrameExpiresAtMicros = pending.startedAtMicros + 6_000_000;
  };
  const retireDiagnosticWindowFrameAfterQuietTail = (traceId: string): void => {
    const atMicros = diagnosticNowMicros();
    if (diagnosticWindowFrame?.traceId === traceId && atMicros !== null)
      diagnosticWindowFrameExpiresAtMicros = atMicros + 1_000_000;
  };

  const liveSelectionTarget = (): LivePaneSelectionTarget | null => {
    const active = options.generation();
    if (
      active?.status !== "live" ||
      !active.daemonGeneration ||
      !active.client ||
      !active.connection
    )
      return null;
    return {
      status: "live",
      daemonGeneration: active.daemonGeneration,
      workspaceName: active.connection.workspaceName,
      client: active.client,
    };
  };
  const maybeRequestWindowSwitchFrame = (): void => {
    const pending = pendingWindowSwitch;
    if (
      !pending ||
      pending.followUpRequested ||
      !pending.selectionApplied ||
      !pending.layoutPublished ||
      !pending.presentationPublished
    )
      return;
    pending.followUpRequested = true;
    try {
      options.requestRender?.();
    } catch {
      pendingWindowSwitch = null;
    }
  };

  const paneInput = new TerminalPaneInputRouter<{
    readonly input: SessionRuntimeTerminalInput;
    readonly parserOrigin?: Pick<TuiTerminalInputOrigin, "origin" | "payload">;
  }>({
    select: async (paneId) => {
      const expected = liveSelectionTarget();
      const selecting = pendingWindowSwitch;
      const operationId = selecting?.traceId;
      const selectionFailure: { current: PaneSelectionFailure | null } = { current: null };
      const receipt = expected
        ? await selectTerminalPane(
            expected,
            liveSelectionTarget,
            paneId,
            operationId,
            (failure) => {
              selectionFailure.current = failure;
            },
          )
        : null;
      if (selecting && pendingWindowSwitch === selecting) {
        const receiptAtMicros = options.detailedWindowSwitchTiming ? diagnosticNowMicros() : null;
        if (selecting.timing) selecting.timing.receiptAtMicros = receiptAtMicros;
        selecting.selectionApplied =
          receipt?.applied === true &&
          receipt.operationId === selecting.traceId &&
          receipt.semanticPaneId === selecting.paneId;
        diagnose("window-switch-receipt", {
          traceId: selecting.traceId,
          target: selecting.target,
          paneId: selecting.paneId,
          operationId: receipt?.operationId ?? null,
          selected: receipt !== null,
          applied: receipt?.applied === true,
          daemonGeneration: selecting.daemonGeneration,
          clientGeneration: selecting.clientGeneration,
          rendererEpoch: selecting.rendererEpoch,
          sourceEpoch: selecting.sourceEpoch,
          generation: selecting.generation,
          incarnation: selecting.incarnation,
          revision: selecting.revision,
          stateHash: selecting.stateHash,
          cols: selecting.cols,
          rows: selecting.rows,
          failureStage: selectionFailure.current?.stage ?? (expected ? null : "pre-dispatch"),
          failureReason:
            selectionFailure.current?.reason ?? (expected ? null : "generation-replaced"),
          failureBackendReason: selectionFailure.current?.backendReason ?? null,
          durationMicros:
            receiptAtMicros === null ? null : receiptAtMicros - selecting.startedAtMicros,
          ...(receiptAtMicros === null ? {} : { phaseAtMicros: receiptAtMicros }),
        });
        if (!selecting.selectionApplied) {
          diagnoseCritical(`window-switch:${selecting.traceId}:failed`, "window-switch-failed", {
            traceId: selecting.traceId,
            target: selecting.target,
            paneId: selecting.paneId,
            daemonGeneration: selecting.daemonGeneration,
            clientGeneration: selecting.clientGeneration,
            rendererEpoch: selecting.rendererEpoch,
            sourceEpoch: selecting.sourceEpoch,
            generation: selecting.generation,
            incarnation: selecting.incarnation,
            revision: selecting.revision,
            stateHash: selecting.stateHash,
            cols: selecting.cols,
            rows: selecting.rows,
            stage: selectionFailure.current?.stage ?? (expected ? "receipt" : "pre-dispatch"),
            reason:
              selectionFailure.current?.reason ??
              (expected ? "receipt-invalid" : "generation-replaced"),
            backendReason: selectionFailure.current?.backendReason ?? null,
            durationMicros:
              receiptAtMicros === null ? null : receiptAtMicros - selecting.startedAtMicros,
          });
          pendingWindowSwitch = null;
          return false;
        }
        maybeRequestWindowSwitchFrame();
      }
      return receipt !== null;
    },
    send: async (paneId, routed) => {
      const { input, parserOrigin } = routed;
      const active = options.generation();
      if (active?.status !== "live" || !active.fastLane) return;
      let fixtureEnabled: boolean;
      let canonical: ReturnType<typeof active.fastLane.lane.paneState> = null;
      let trace: TuiTerminalInputTrace | undefined;
      try {
        const performanceSink = currentTuiPerformanceEventSink();
        fixtureEnabled = Boolean(performanceSink?.beginTerminalInput && causalCellFixtureEnabled());
        if (performanceSink?.beginTerminalInput && (parserOrigin || fixtureEnabled))
          canonical = active.fastLane.lane.paneState(paneId);
        trace = performanceSink?.beginTerminalInput?.(
          parserOrigin && canonical && active.daemonGeneration
            ? {
                ...parserOrigin,
                semanticPaneId: paneId,
                generation: active.daemonGeneration,
                incarnation: canonical.incarnation,
                revision: canonical.revision,
                stateHash: canonical.hash,
              }
            : undefined,
        );
      } catch {
        // Diagnostics are opt-in and must never block the product input path.
        fixtureEnabled = false;
        canonical = null;
        trace = undefined;
      }
      let fixture =
        trace && fixtureEnabled
          ? prepareCausalCellFixtureV1(canonical, input, trace.traceId)
          : null;
      if (fixture) {
        let armed: boolean | undefined;
        try {
          armed = active.fastLane.causalCellLedger?.arm(fixture.probe, nowMicros());
        } catch {
          fixture = null;
          armed = true;
        }
        if (armed !== true) {
          try {
            trace?.cancel();
          } catch {
            // Diagnostics fail open while declining this diagnostic probe.
          }
          trace = undefined;
          fixture = null;
        }
      }
      const pending = active.fastLane.lane.sendInput(
        paneId,
        fixture?.input ?? input,
        trace?.traceId,
        fixture?.probe,
      );
      try {
        trace?.finish();
      } catch {
        // The real input has already been dispatched; diagnostics fail open.
      }
      const outcome = await pending;
      if (outcome.status !== "sent") {
        try {
          trace?.cancel();
        } catch {
          // Diagnostics fail open after the product transport outcome.
        }
        if (fixture)
          try {
            active.fastLane.causalCellLedger?.fail(fixture.probe.traceId, "authority-lost");
          } catch {
            // Diagnostics fail open after the product transport outcome.
          }
      }
    },
    onFocusedPane: options.setFocusedPane,
  });

  return {
    adoptGeneration(snapshot) {
      let next: typeof inputAuthorityIdentity = null;
      if (
        snapshot?.status === "live" &&
        snapshot.daemonGeneration &&
        snapshot.connection &&
        snapshot.client &&
        snapshot.fastLane &&
        snapshot.adapter
      ) {
        try {
          const clientGeneration = snapshot.client.getSnapshot().generation;
          if (Number.isSafeInteger(clientGeneration))
            next = {
              daemonGeneration: snapshot.daemonGeneration,
              clientGeneration: clientGeneration!,
              rendererEpoch: snapshot.rendererEpoch,
              connection: snapshot.connection,
              client: snapshot.client,
              fastLane: snapshot.fastLane,
              adapter: snapshot.adapter,
            };
        } catch {
          next = null;
        }
      }
      const replaced =
        next !== null &&
        inputAuthorityIdentity !== null &&
        (next.daemonGeneration !== inputAuthorityIdentity.daemonGeneration ||
          next.clientGeneration !== inputAuthorityIdentity.clientGeneration ||
          next.rendererEpoch !== inputAuthorityIdentity.rendererEpoch ||
          next.connection !== inputAuthorityIdentity.connection ||
          next.client !== inputAuthorityIdentity.client ||
          next.fastLane !== inputAuthorityIdentity.fastLane ||
          next.adapter !== inputAuthorityIdentity.adapter);
      if (next === null || replaced) {
        paneInput.invalidateSelection();
        pendingWindowSwitch = null;
        pendingWindowRename = null;
        diagnosticWindowFrame = null;
      }
      inputAuthorityIdentity = next;
    },
    adoptLayout(snapshot) {
      paneInput.adoptCanonicalPane(snapshot.current ? paneForWindow(snapshot.current) : null);
      const currentWindow = snapshot.current?.semanticWindowId ?? snapshot.current?.windowName;
      const currentPane = snapshot.current ? paneForWindow(snapshot.current) : null;
      const currentName = snapshot.current?.windowName ?? null;
      if (
        options.diagnosticsEnabled &&
        previousCurrentWindow &&
        currentWindow === previousCurrentWindow.target &&
        currentPane === previousCurrentWindow.paneId &&
        currentName &&
        currentName !== previousCurrentWindow.name
      ) {
        try {
          const active = options.generation();
          const identity = active?.adapter?.paneCanonicalIdentity(currentPane);
          const clientGeneration = active?.client?.getSnapshot().generation;
          pendingWindowRename =
            active?.status === "live" &&
            active.daemonGeneration &&
            identity &&
            Number.isSafeInteger(clientGeneration)
              ? {
                  traceId: createTraceId(),
                  target: currentWindow!,
                  paneId: currentPane,
                  previousName: previousCurrentWindow.name,
                  windowName: currentName,
                  startedAtMicros: nowMicros(),
                  daemonGeneration: active.daemonGeneration,
                  clientGeneration: clientGeneration!,
                  rendererEpoch: active.rendererEpoch,
                  sourceEpoch: identity.sourceEpoch,
                  generation: identity.generation,
                  incarnation: identity.incarnation,
                  revision: identity.revision,
                  stateHash: identity.stateHash,
                  cols: identity.cols,
                  rows: identity.rows,
                  presentationPublished: false,
                  followUpRequested: false,
                }
              : null;
          if (pendingWindowRename) {
            armDiagnosticWindowFrame({ kind: "window-rename", ...pendingWindowRename });
            diagnose("window-rename-start", { ...pendingWindowRename });
          }
        } catch {
          pendingWindowRename = null;
        }
      }
      previousCurrentWindow =
        currentWindow && currentPane && currentName
          ? { target: currentWindow, paneId: currentPane, name: currentName }
          : null;
      if (pendingWindowSwitch && currentWindow === pendingWindowSwitch.target) {
        pendingWindowSwitch.layoutPublished = true;
        if (pendingWindowSwitch.timing && pendingWindowSwitch.timing.layoutAtMicros === null) {
          pendingWindowSwitch.timing.layoutAtMicros = diagnosticNowMicros();
          diagnose("window-switch-layout", {
            ...pendingWindowSwitch,
            phaseAtMicros: pendingWindowSwitch.timing.layoutAtMicros,
          });
        }
      }
      maybeRequestWindowSwitchFrame();
    },
    selectPane: (paneId) => paneInput.selectPane(paneId),
    sendInput: async (input, parserOrigin) => {
      await paneInput.sendInput({ input, parserOrigin });
    },
    previewPaneResize() {
      if (!options.diagnosticsEnabled || pendingResizeGuide) return;
      pendingResizeGuide = { traceId: createTraceId(), startedAtMicros: nowMicros() };
    },
    resizePane(preview) {
      const expected = options.generation();
      if (expected?.status !== "live" || !expected.client || !expected.connection) return;
      const expectedGeneration = expected.daemonGeneration;
      const expectedClient = expected.client;
      void (async () => {
        const lease = await expectedClient.requestAuthority("geometry");
        const current = options.generation();
        if (
          !lease ||
          current?.status !== "live" ||
          current.daemonGeneration !== expectedGeneration ||
          current.client !== expectedClient
        )
          return;
        await expectedClient.dispatch({
          kind: "semantic-intent",
          operationId: createTraceId(),
          intent: {
            verb: "workspace.pane.resize",
            workspaceName: expected.connection!.workspaceName,
            semanticPaneId: preview.semanticPaneId,
            axis: preview.axis,
            cells: preview.cells,
          },
        });
      })().catch((error: unknown) => {
        options.diagnose("pane-resize-rejected", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    },
    cycleWindow() {
      const windows = options.layout().windows;
      if (windows.length < 2) return;
      const current = windows.findIndex((window) => window.currentWindow);
      const next = windows[(current + 1 + windows.length) % windows.length];
      const pane = next ? paneForWindow(next) : null;
      const target = next?.semanticWindowId ?? next?.windowName;
      if (!pane || !target) return;
      if (options.diagnosticsEnabled) {
        try {
          const active = options.generation();
          const identity = active?.adapter?.paneCanonicalIdentity(pane);
          const clientGeneration = active?.client?.getSnapshot().generation;
          const startedAtMicros = diagnosticNowMicros();
          if (
            active?.status === "live" &&
            active.daemonGeneration &&
            identity &&
            Number.isSafeInteger(clientGeneration) &&
            startedAtMicros !== null
          ) {
            pendingWindowSwitch = {
              traceId: createTraceId(),
              target,
              paneId: pane,
              startedAtMicros,
              daemonGeneration: active.daemonGeneration,
              clientGeneration: clientGeneration!,
              rendererEpoch: active.rendererEpoch,
              sourceEpoch: identity.sourceEpoch,
              generation: identity.generation,
              incarnation: identity.incarnation,
              revision: identity.revision,
              stateHash: identity.stateHash,
              cols: identity.cols,
              rows: identity.rows,
              layoutPublished: false,
              selectionApplied: false,
              presentationPublished: false,
              followUpRequested: false,
              ...(options.detailedWindowSwitchTiming
                ? {
                    timing: {
                      receiptAtMicros: null,
                      layoutAtMicros: null,
                      presentationAtMicros: null,
                    },
                  }
                : {}),
            };
            armDiagnosticWindowFrame({ kind: "window-switch", ...pendingWindowSwitch });
            diagnose("window-switch-start", { ...pendingWindowSwitch });
          }
        } catch {
          pendingWindowSwitch = null;
        }
      }
      paneInput.selectPane(pane, { presentOptimistically: false });
    },
    observeWindowPresentation(semanticWindowId, paneId, windowName) {
      const rename = pendingWindowRename;
      if (
        rename &&
        !rename.presentationPublished &&
        semanticWindowId === rename.target &&
        paneId === rename.paneId &&
        windowName === rename.windowName
      ) {
        rename.presentationPublished = true;
        diagnose("window-rename-presentation", { ...rename });
      }
      const pending = pendingWindowSwitch;
      if (
        !pending ||
        pending.presentationPublished ||
        semanticWindowId !== pending.target ||
        paneId !== pending.paneId
      )
        return;
      try {
        const active = options.generation();
        const identity = active?.adapter?.paneCanonicalIdentity(paneId);
        const clientGeneration = active?.client?.getSnapshot().generation;
        if (
          active?.status !== "live" ||
          active.daemonGeneration !== pending.daemonGeneration ||
          active.rendererEpoch !== pending.rendererEpoch ||
          clientGeneration !== pending.clientGeneration ||
          identity?.sourceEpoch !== pending.sourceEpoch ||
          identity.generation !== pending.generation ||
          identity.incarnation !== pending.incarnation ||
          identity.revision !== pending.revision ||
          identity.stateHash !== pending.stateHash ||
          identity.cols !== pending.cols ||
          identity.rows !== pending.rows
        ) {
          pendingWindowSwitch = null;
          return;
        }
      } catch {
        pendingWindowSwitch = null;
        return;
      }
      pending.presentationPublished = true;
      if (pending.timing && pending.timing.presentationAtMicros === null)
        pending.timing.presentationAtMicros = diagnosticNowMicros();
      diagnose("window-switch-presentation", {
        ...pending,
        ...(pending.timing?.presentationAtMicros == null
          ? {}
          : { phaseAtMicros: pending.timing.presentationAtMicros }),
      });
    },
    observeDiagnosticWindowFrame() {
      if (!options.diagnosticsEnabled) return null;
      const observedAtMicros = diagnosticNowMicros();
      if (
        diagnosticWindowFrame &&
        observedAtMicros !== null &&
        observedAtMicros > diagnosticWindowFrameExpiresAtMicros
      )
        diagnosticWindowFrame = null;
      const context = diagnosticWindowFrame;
      try {
        const snapshot = options.layout();
        const active = options.generation();
        const visible = snapshot.current;
        const visibleTarget = visible?.semanticWindowId ?? visible?.windowName ?? null;
        const visiblePane = visible ? paneForWindow(visible) : null;
        const identity = visiblePane ? active?.adapter?.paneCanonicalIdentity(visiblePane) : null;
        const presentationDigest = createHash("sha256")
          .update(
            JSON.stringify({
              daemonGeneration: active?.daemonGeneration ?? null,
              clientGeneration: active?.client?.getSnapshot().generation ?? null,
              rendererEpoch: active?.rendererEpoch ?? null,
              presentedFocusedPaneDigest: createHash("sha256")
                .update(options.focusedPane?.() ?? "")
                .digest("hex"),
              rendererFocused: options.rendererFocused?.() ?? true,
              shellPresentation: options.shellPresentation?.() ?? null,
              visibleTarget,
              visiblePane,
              identity: identity
                ? [
                    identity.sourceEpoch,
                    identity.generation,
                    identity.incarnation,
                    identity.revision,
                    identity.stateHash,
                    identity.cols,
                    identity.rows,
                  ]
                : null,
              windows: snapshot.windows.map((window) => [
                window.semanticWindowId ?? null,
                window.windowName,
                window.currentWindow,
                window.cols,
                window.rows,
                window.panes.map((pane) => [
                  pane.pane ?? null,
                  pane.active,
                  pane.left,
                  pane.top,
                  pane.width,
                  pane.height,
                ]),
              ]),
            }),
          )
          .digest("hex");
        const presentationChanged = lastWindowPresentationDigest
          ? presentationDigest !== lastWindowPresentationDigest
          : null;
        lastWindowPresentationDigest = presentationDigest;
        if (!context) return null;
        const targetVisible = visibleTarget === context.target && visiblePane === context.paneId;
        const identityExact =
          active?.status === "live" &&
          active.daemonGeneration === context.daemonGeneration &&
          active.rendererEpoch === context.rendererEpoch &&
          active.client?.getSnapshot().generation === context.clientGeneration &&
          identity?.sourceEpoch === context.sourceEpoch &&
          identity.generation === context.generation &&
          identity.incarnation === context.incarnation &&
          identity.revision === context.revision &&
          identity.stateHash === context.stateHash &&
          identity.cols === context.cols &&
          identity.rows === context.rows;
        const currentSwitch = pendingWindowSwitch;
        const currentRename = pendingWindowRename;
        const settledTargetFrame =
          targetVisible &&
          identityExact &&
          (context.kind === "window-switch"
            ? currentSwitch?.traceId === context.traceId &&
              currentSwitch.layoutPublished &&
              currentSwitch.selectionApplied &&
              currentSwitch.presentationPublished
            : currentRename?.traceId === context.traceId && currentRename.presentationPublished);
        return Object.freeze({
          kind: context.kind,
          traceId: context.traceId,
          targetIdentityDigest: createHash("sha256").update(context.target).digest("hex"),
          paneIdentityDigest: createHash("sha256").update(context.paneId).digest("hex"),
          daemonGeneration: context.daemonGeneration,
          clientGeneration: context.clientGeneration,
          rendererEpoch: context.rendererEpoch,
          sourceEpoch: context.sourceEpoch,
          generation: context.generation,
          incarnation: context.incarnation,
          revision: context.revision,
          stateHash: context.stateHash,
          cols: context.cols,
          rows: context.rows,
          presentationDigest,
          presentationChanged,
          identityExact,
          targetVisible,
          settledTargetFrame,
        });
      } catch {
        return null;
      }
    },
    settleWindowSwitchFrame() {
      const rename = pendingWindowRename;
      if (rename?.presentationPublished) {
        const valid = (() => {
          try {
            const active = options.generation();
            const identity = active?.adapter?.paneCanonicalIdentity(rename.paneId);
            return (
              active?.status === "live" &&
              active.daemonGeneration === rename.daemonGeneration &&
              active.rendererEpoch === rename.rendererEpoch &&
              active.client?.getSnapshot().generation === rename.clientGeneration &&
              identity?.sourceEpoch === rename.sourceEpoch &&
              identity.generation === rename.generation &&
              identity.incarnation === rename.incarnation &&
              identity.revision === rename.revision &&
              identity.stateHash === rename.stateHash &&
              identity.cols === rename.cols &&
              identity.rows === rename.rows
            );
          } catch {
            return false;
          }
        })();
        pendingWindowRename = null;
        if (valid) {
          retireDiagnosticWindowFrameAfterQuietTail(rename.traceId);
          const renamedAtMicros = diagnosticNowMicros();
          const details = {
            ...rename,
            durationMicros:
              renamedAtMicros === null ? null : renamedAtMicros - rename.startedAtMicros,
          };
          diagnoseCritical(
            `window-rename:${rename.traceId}:presented`,
            "window-rename-presented",
            details,
          );
          let writerHealth = null;
          try {
            writerHealth = options.diagnosticHealth?.() ?? null;
          } catch {
            // Missing health remains explicit in the critical fence.
          }
          diagnoseCritical(`window-rename:${rename.traceId}:fence`, "window-rename-fence", {
            ...details,
            writerHealth,
          });
        }
      }
      if (
        !pendingWindowSwitch?.layoutPublished ||
        !pendingWindowSwitch.selectionApplied ||
        !pendingWindowSwitch.presentationPublished
      )
        return;
      const settled = pendingWindowSwitch;
      try {
        const active = options.generation();
        const identity = active?.adapter?.paneCanonicalIdentity(settled.paneId);
        const clientGeneration = active?.client?.getSnapshot().generation;
        if (
          active?.status !== "live" ||
          active.daemonGeneration !== settled.daemonGeneration ||
          active.rendererEpoch !== settled.rendererEpoch ||
          clientGeneration !== settled.clientGeneration ||
          identity?.sourceEpoch !== settled.sourceEpoch ||
          identity.generation !== settled.generation ||
          identity.incarnation !== settled.incarnation ||
          identity.revision !== settled.revision ||
          identity.stateHash !== settled.stateHash ||
          identity.cols !== settled.cols ||
          identity.rows !== settled.rows
        ) {
          pendingWindowSwitch = null;
          return;
        }
      } catch {
        pendingWindowSwitch = null;
        return;
      }
      pendingWindowSwitch = null;
      retireDiagnosticWindowFrameAfterQuietTail(settled.traceId);
      const frameAtMicros = diagnosticNowMicros();
      const settledDetails = {
        ...settled,
        durationMicros: frameAtMicros === null ? null : frameAtMicros - settled.startedAtMicros,
        ...(options.detailedWindowSwitchTiming && frameAtMicros !== null
          ? { phaseAtMicros: frameAtMicros }
          : {}),
      };
      diagnoseCritical(
        `window-switch:${settled.traceId}:settled`,
        "window-switch-settled",
        settledDetails,
      );
      let writerHealth = null;
      try {
        writerHealth = options.diagnosticHealth?.() ?? null;
      } catch {
        // A missing health proof remains explicit in the retained fence.
      }
      diagnoseCritical(`window-switch:${settled.traceId}:fence`, "window-switch-fence", {
        ...settledDetails,
        writerHealth,
      });
    },
    settleResizeGuideFrame() {
      if (!pendingResizeGuide) return;
      const settled = pendingResizeGuide;
      pendingResizeGuide = null;
      options.diagnose("resize-guide-settled", {
        traceId: settled.traceId,
        durationMicros: nowMicros() - settled.startedAtMicros,
      });
    },
  };
}
