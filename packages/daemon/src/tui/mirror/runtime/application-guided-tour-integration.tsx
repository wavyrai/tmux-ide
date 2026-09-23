/* @jsxImportSource @opentui/solid */
import { randomUUID } from "node:crypto";
import { createEffect, createMemo, Show, type Accessor } from "solid-js";
import { createApplicationGuidedTourOwner } from "./application-guided-tour-owner.ts";
import { GuidedTourCoach } from "./guided-tour-coach.tsx";
import type { GuidedTourPractice } from "./guided-tour.ts";
import { createFleetSession } from "./fleet-lifecycle-client.ts";
import { applicationMachineAuthorityManager } from "./application-machine-authority.ts";
import type { createApplicationMachineNavigation } from "./application-machine-navigation.ts";
import type { ApplicationAppearanceOwner } from "./application-appearance-owner.ts";
import type { createApplicationHomeNavigationOwner } from "./application-home-agents-owner.ts";
import type { OpenTuiGenerationHostSnapshot } from "./open-tui-generation-host.ts";
import type { OpenTuiWorkspaceLayoutSnapshot } from "../open-tui-workspace-runtime-port.ts";

export function createApplicationGuidedTourIntegration(options: {
  machines: ReturnType<typeof createApplicationMachineNavigation>;
  lifecycle: { signal: AbortSignal };
  generation: Accessor<OpenTuiGenerationHostSnapshot | null>;
  generationMachineId: Accessor<string | null>;
  layoutSnapshot: Accessor<OpenTuiWorkspaceLayoutSnapshot>;
  sessionName: () => string | null;
  focusedPane: Accessor<string | null>;
  activeSurface: Accessor<"home" | "terminals">;
  appearance: ApplicationAppearanceOwner;
  paletteOpen: Accessor<boolean>;
  paletteCommands: ReturnType<typeof createApplicationHomeNavigationOwner>["paletteCommands"];
  dimensions: Accessor<{ width: number; height: number }>;
  blocked: Accessor<boolean>;
}) {
  const {
    machines,
    lifecycle,
    generation,
    generationMachineId,
    layoutSnapshot,
    sessionName,
    focusedPane,
    activeSurface,
    appearance,
    paletteOpen,
    paletteCommands,
    dimensions,
    blocked,
  } = options;
  const practiceRows = () =>
    machines.catalog
      .getSnapshot()
      .groups.filter((group) => group.id === "local" || group.routeIds?.includes("local"))
      .flatMap((group) => group.sessions)
      .filter((row) => !row.disabled);
  const practiceIdentity = (
    row: ReturnType<typeof practiceRows>[number],
  ): GuidedTourPractice | null => {
    const daemon = applicationMachineAuthorityManager.getMachine("local")?.read();
    if (!row.liveSessionId || !daemon) return null;
    return {
      machineId: "local",
      serverId: row.server?.serverId ?? "default",
      generation: row.server?.generation ?? daemon.instanceId,
      sessionId: row.liveSessionId,
      sessionName: row.name,
    };
  };
  const tour = createApplicationGuidedTourOwner({
    async createPractice() {
      const handle = applicationMachineAuthorityManager.getMachine("local");
      if (!handle || handle.endpoint().state !== "ready")
        throw new Error("Connect this machine before creating a practice session.");
      const created = await createFleetSession(
        handle,
        `tmux-ide-practice-${randomUUID().slice(0, 8)}`,
        undefined,
        { includeLiveSessionId: true },
      );
      if (!created || created.outcome !== "created")
        throw new Error("Could not create a fresh practice session. Try again.");
      if (!created.liveSessionId)
        throw new Error(
          "Update the local tmux-ide daemon to use the guided practice session, then restart the tour.",
        );
      return await new Promise<GuidedTourPractice>((resolve, reject) => {
        let done = false;
        let stop = () => {};
        const abort = () => {
          clearTimeout(timer);
          stop();
          reject(new Error("Tour closed."));
        };
        const timer = setTimeout(() => {
          lifecycle.signal.removeEventListener("abort", abort);
          stop();
          reject(
            new Error(
              "Practice session was created but has not appeared yet. Find it in the local session list.",
            ),
          );
        }, 10_000);
        lifecycle.signal.addEventListener("abort", abort, { once: true });
        const check = () => {
          const rows = practiceRows().filter(
            (row) =>
              row.name === created.workspaceName && row.liveSessionId === created.liveSessionId,
          );
          const identity = rows.length === 1 ? practiceIdentity(rows[0]!) : null;
          if (!identity || identity.generation !== created.daemonInstanceId) return;
          done = true;
          lifecycle.signal.removeEventListener("abort", abort);
          clearTimeout(timer);
          stop();
          resolve(identity);
        };
        stop = machines.catalog.subscribe(check);
        if (done) stop();
        else if (lifecycle.signal.aborted) abort();
        else check();
      });
    },
    openPractice(practice) {
      if (practice.machineId !== "local")
        throw new Error("Practice sessions must belong to this machine. Restart the tour.");
      const row = practiceRows().find((row) => {
        const identity = practiceIdentity(row);
        return (
          identity &&
          identity.serverId === practice.serverId &&
          identity.generation === practice.generation &&
          identity.sessionId === practice.sessionId
        );
      });
      if (!row)
        throw new Error(
          "That practice session is unavailable or has been replaced. Replay the tour to create a new one.",
        );
      machines.sidebar.onOpen("local", row.name, "mouse", row.id);
    },
  });
  const committedTourTheme = createMemo<string>((previous) =>
    appearance.pickerOpen()
      ? (previous ?? JSON.stringify(appearance.theme().canonical))
      : JSON.stringify(appearance.theme().canonical),
  );
  createEffect(() => {
    const current = generation();
    const connection = current?.status === "live" ? current.connection : null;
    const machineId = generationMachineId();
    const practice =
      connection?.liveSessionId && current?.daemonGeneration && machineId
        ? {
            machineId,
            serverId: connection.server?.serverId ?? "default",
            generation: connection.server?.generation ?? current.daemonGeneration,
            sessionId: connection.liveSessionId,
            sessionName: sessionName() ?? "",
          }
        : null;
    tour.observe({
      practice,
      panes: (layoutSnapshot().current?.panes ?? []).flatMap((pane) =>
        pane.pane ? [{ id: pane.pane, width: pane.width, height: pane.height }] : [],
      ),
      focusedPane: focusedPane(),
      surface: activeSurface(),
      paletteOpen: paletteOpen(),
      theme: committedTourTheme(),
    });
  });
  return {
    ...tour,
    Coach: () => (
      <Show when={tour.state().active && !blocked()}>
        <box
          position="absolute"
          right={1}
          bottom={2}
          width={Math.max(1, Math.min(68, dimensions().width - 2))}
          zIndex={30}
        >
          <GuidedTourCoach
            height={Math.max(4, Math.min(10, dimensions().height - 4))}
            state={tour.state()}
            theme={appearance.theme()}
            width={Math.max(1, Math.min(68, dimensions().width - 2))}
            shortcuts={{ commands: "F5", home: "F1" }}
            error={tour.error()}
            busy={tour.busy()}
            onPause={tour.pause}
            onReplay={tour.replay}
            onWelcomeRead={tour.welcomeRead}
            onCreatePractice={() => void tour.createPractice()}
            onOpenCommands={() => paletteCommands.setOpen(true, "mouse")}
            onOpenAppearance={appearance.openPicker}
            onOpenHome={() => paletteCommands.openSurface("home", "mouse")}
            onOpenPractice={() => void tour.openPractice()}
          />
        </box>
      </Show>
    ),
  };
}
