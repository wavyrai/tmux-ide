import type { LiveSnapshot } from "../../client";
import { leaves, type Workspace } from "@superlogical/shared/model";
import { WorkbenchSidebar, type WorkbenchWindow } from "../../design-workbench/workbench-sidebar";
import type { SidebarPane } from "../../design-workbench/workbench-sidebar";

/** Catalog adapter only: shared navigation never opens transports or mutates tmux. */
export function LiveSidebar({
  workspace,
  active,
  selected,
  home,
  onHome,
  onTerminals,
  onSelect,
  connection,
  machines,
  onRetry,
}: {
  workspace: Workspace | null;
  active: string;
  selected: string;
  home: boolean;
  onHome: () => void;
  onTerminals: () => void;
  onSelect: (id: string, pane?: string) => void;
  connection: string;
  machines?: LiveSnapshot["machines"];
  onRetry?: (connectionId: string) => void;
}) {
  const windows: WorkbenchWindow[] = (workspace?.tabs ?? [])
    .filter((tab) => !tab.hidden)
    .map((tab) => ({
      id: tab.id,
      name: tab.name,
      machine: tab.machine || "Local",
      machineId: tab.machineId ?? tab.daemonInstanceId ?? tab.id,
      session: tab.name,
      sessionId: tab.fleetSessionId ?? tab.id,
      paneCount: tab.paneCount,
      layout: null,
      panes: leaves(tab.layout),
    }));
  const panes: Record<string, SidebarPane> = Object.fromEntries(
    Object.entries(workspace?.panes ?? {}).map(([id, pane]) => [
      id,
      {
        id,
        title: pane.agent?.name || pane.command,
        command: pane.command,
        state:
          pane.agent?.activity === "running"
            ? "working"
            : pane.agent?.activity === "waiting" || pane.agent?.activity === "failed"
              ? "needs input"
              : "idle",
      },
    ]),
  );
  return (
    <>
      <WorkbenchSidebar
        windows={windows}
        panes={panes}
        active={active}
        selected={selected}
        home={home}
        onHome={onHome}
        onTerminals={onTerminals}
        onSelect={onSelect}
        machineStatus={
          <>
            {" "}
            {machines
              ?.filter((machine) => machine.status !== "paired")
              .map((machine) => (
                <div key={machine.connectionId} className="dw-section" role="status">
                  <span className="dw-section-label">
                    {machine.label} · {machine.status}
                  </span>
                  {machine.status === "offline" && (
                    <button className="dw-row" onClick={() => onRetry?.(machine.connectionId)}>
                      Reconnect
                    </button>
                  )}
                </div>
              ))}{" "}
          </>
        }
        footer={["Live workspace", connection]}
      />
    </>
  );
}
