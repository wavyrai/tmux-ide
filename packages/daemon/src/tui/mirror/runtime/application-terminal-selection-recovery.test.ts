import { describe, expect, it, vi } from "vitest";
import type { OpenTuiGenerationHostSnapshot } from "./open-tui-generation-host.ts";
import type { OpenTuiWorkspaceLayoutSnapshot } from "../open-tui-workspace-runtime-port.ts";
import { createOpenTuiRuntimeLayoutPresentation } from "./runtime-layout-presentation.ts";
import { createApplicationTerminalInteractionController } from "./application-terminal-interaction-controller.ts";
const drain = async () => {
  for (let n = 0; n < 12; n++) await Promise.resolve();
};
function layout(
  selected: string,
  present = true,
  rendererEpoch = 1,
): OpenTuiWorkspaceLayoutSnapshot {
  const windows = (present ? ["original", "agent"] : ["original"]).map((name) => ({
    type: "layout" as const,
    semanticWindowId: `window.${name}`,
    windowName: name,
    currentWindow: name === selected,
    cols: 20,
    rows: 8,
    zoomed: false,
    paneBorderStatus: "off" as const,
    panes: [{ pane: `pane.${name}`, left: 0, top: 0, width: 20, height: 8, active: true }],
  }));
  return {
    rendererEpoch,
    current: windows.find((window) => window.currentWindow) ?? windows[0]!,
    windows,
  };
}
describe("selection across terminal topology retirement", () => {
  for (const admission of [
    "in-flight",
    "during-rebind",
    "after-rebind-topology",
    "after-authority-topology",
    "layout-before-generation",
    "retained-layout",
  ] as const) {
    it.each(
      [
        "confirmed",
        "unconfirmed",
        "no-active",
        "ambiguous-active",
        "inactive-window",
        "late-error",
        "denied",
        "timeout",
        "missing",
        "client",
        "connection",
        "daemon",
        "client-generation",
        "cancel",
        "superseded",
      ].filter((outcome) =>
        [
          "after-rebind-topology",
          "after-authority-topology",
          "layout-before-generation",
          "retained-layout",
        ].includes(admission)
          ? outcome === "confirmed"
          : admission === "in-flight" ||
            ![
              "unconfirmed",
              "no-active",
              "ambiguous-active",
              "inactive-window",
              "late-error",
            ].includes(outcome),
      ),
    )(
      `${admission}: retains exact intent only until same-control confirmation (%s)`,
      async (outcome) => {
        vi.useFakeTimers();
        let clientGeneration = 1;
        let grantAuthority: ((lease: object) => void) | undefined;
        let rejectSelection: ((error: Error) => void) | undefined;
        const send = vi.fn(async (..._args: unknown[]) => ({ status: "sent" }));
        const dispatch = vi.fn(async (command) => {
          if (outcome === "late-error" && command.intent.semanticPaneId === "pane.agent")
            return new Promise<never>((_resolve, reject) => {
              rejectSelection = reject;
            });
          if (admission !== "during-rebind" || outcome === "denied")
            throw Object.assign(new Error("selection transport outcome"), {
              code: outcome === "denied" ? "authority-denied" : "topology-changed",
            });
          return {
            kind: "semantic-intent",
            operationId: "op",
            result: {
              operationId: "op",
              verb: "workspace.pane.select",
              semanticPaneId: command.intent.semanticPaneId,
              workspaceName: "session",
              daemonInstanceId: "daemon",
              outcome: "applied",
            },
          };
        });
        const client = {
          getSnapshot: () => ({ generation: clientGeneration }),
          ownsRuntimeAuthority: () => admission !== "after-authority-topology",
          requestAuthority: async () =>
            admission === "after-authority-topology"
              ? new Promise<object>((resolve) => {
                  grantAuthority = resolve;
                })
              : {},
          dispatch,
        };
        let generation = {
          status: "live",
          daemonGeneration: "daemon",
          rendererEpoch: 1,
          connection: { workspaceName: "session" },
          client,
          fastLane: { lane: { sendInput: send } },
          adapter: {},
        } as unknown as OpenTuiGenerationHostSnapshot;
        let currentLayout = layout("original");
        let focused: string | null = null;
        const controller = createApplicationTerminalInteractionController({
          generation: () => generation,
          layout: () => currentLayout,
          setFocusedPane: ((pane: string | null) => {
            focused = pane;
          }) as never,
          diagnosticsEnabled: false,
          diagnose: () => undefined,
          causalCellFixtureEnabled: () => false,
        });
        // Production adopts callbacks before updating their reactive accessors.
        const adoptGeneration = (next: OpenTuiGenerationHostSnapshot) => {
          controller.adoptGeneration(next);
          generation = next;
        };
        const adoptLayout = (next: OpenTuiWorkspaceLayoutSnapshot) => {
          controller.adoptLayout(next);
          currentLayout = next;
        };
        try {
          adoptGeneration(generation);
          adoptLayout(currentLayout);
          if (admission === "during-rebind" || admission === "after-rebind-topology")
            adoptGeneration({ ...generation, status: "rebinding" });
          controller.selectPane("pane.agent");
          expect(focused).toBe("pane.agent");
          const typing = controller.sendInput({ kind: "text", data: "after-click" });
          if (["in-flight", "layout-before-generation", "retained-layout"].includes(admission))
            adoptGeneration({ ...generation, status: "rebinding" });
          await drain();
          expect(send).not.toHaveBeenCalled();
          if (outcome !== "denied") expect(focused).toBe("pane.agent");
          expect(dispatch).toHaveBeenCalledTimes(
            ["in-flight", "layout-before-generation", "retained-layout"].includes(admission)
              ? 1
              : 0,
          );
          if (outcome === "cancel") controller.cancelPendingInput();
          if (outcome === "superseded" || outcome === "late-error")
            controller.selectPane("pane.original");
          if (outcome === "late-error")
            rejectSelection?.(
              Object.assign(new Error("retired stream"), { code: "topology-changed" }),
            );
          if (outcome === "timeout") await vi.advanceTimersByTimeAsync(5001);
          if (outcome === "client-generation") clientGeneration++;
          if (admission === "layout-before-generation") {
            const presentation = createOpenTuiRuntimeLayoutPresentation();
            presentation.subscribeWindows(adoptLayout);
            presentation.adopt(
              {
                onLayout(listener) {
                  listener(layout("agent"));
                  return () => undefined;
                },
              },
              2,
            );
            // Real host seeds presentation before publishing the replacement epoch.
            expect(send).not.toHaveBeenCalled();
          }
          adoptGeneration({
            ...generation,
            status: "live",
            rendererEpoch: 2,
            client: outcome === "client" ? { ...client } : client,
            connection:
              outcome === "connection" ? { ...generation.connection! } : generation.connection,
            daemonGeneration: outcome === "daemon" ? "other-daemon" : generation.daemonGeneration,
          } as OpenTuiGenerationHostSnapshot);
          if (admission === "retained-layout") {
            // A new live generation cannot confirm from the old retained frame.
            adoptLayout(layout("agent", true, 1));
            await drain();
            expect(send).not.toHaveBeenCalled();
          }
          let nextLayout = layout(
            ["timeout", "unconfirmed"].includes(outcome) ? "original" : "agent",
            outcome !== "missing",
            2,
          );
          if (["no-active", "ambiguous-active", "inactive-window"].includes(outcome)) {
            const current = nextLayout.current!;
            nextLayout = {
              ...nextLayout,
              current: {
                ...current,
                currentWindow: outcome !== "inactive-window",
                panes:
                  outcome === "ambiguous-active"
                    ? [...current.panes, { ...current.panes[0]!, pane: "pane.ambiguous" }]
                    : current.panes.map((pane) => ({ ...pane, active: outcome !== "no-active" })),
              },
            };
          }
          if (admission !== "layout-before-generation") adoptLayout(nextLayout);
          grantAuthority?.({});
          await drain();
          if (admission === "after-rebind-topology" || admission === "after-authority-topology") {
            // The first dispatch used epoch2. Its cached selected frame cannot
            // confirm an operation whose response was lost on that same runtime.
            expect(dispatch).toHaveBeenCalledTimes(1);
            expect(send).not.toHaveBeenCalled();
            adoptGeneration({ ...generation, status: "rebinding" });
            adoptGeneration({ ...generation, status: "live", rendererEpoch: 3 });
            adoptLayout(layout("agent", true, 3));
            await drain();
          }
          if (outcome !== "confirmed") await vi.advanceTimersByTimeAsync(5001);
          if (outcome === "confirmed") expect(send).toHaveBeenCalledTimes(1);
          await typing;
          if (outcome === "confirmed") {
            expect(dispatch).toHaveBeenCalledTimes(1);
            expect(send).toHaveBeenCalledTimes(1);
            expect(send.mock.calls[0]?.slice(0, 2)).toEqual([
              "pane.agent",
              { kind: "text", data: "after-click" },
            ]);
          } else expect(send).not.toHaveBeenCalled();
          adoptLayout(layout("agent"));
          await drain();
          expect(send).toHaveBeenCalledTimes(outcome === "confirmed" ? 1 : 0);
        } finally {
          controller.cancelPendingInput();
          vi.useRealTimers();
        }
      },
    );
  }
});
