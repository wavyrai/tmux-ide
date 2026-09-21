/** Labels are presentation; grouping and selection use opaque identity only. */
export interface SidebarIdentity {
  machineId: string;
  machine: string;
  sessionId: string;
  session: string;
}

export function groupSidebarWindows<T extends SidebarIdentity>(windows: readonly T[]) {
  const machines = new Map<
    string,
    {
      id: string;
      label: string;
      sessions: Map<string, { id: string; label: string; windows: T[] }>;
    }
  >();
  for (const window of windows) {
    let machine = machines.get(window.machineId);
    if (!machine) {
      machine = { id: window.machineId, label: window.machine, sessions: new Map() };
      machines.set(window.machineId, machine);
    }
    let session = machine.sessions.get(window.sessionId);
    if (!session) {
      session = { id: window.sessionId, label: window.session, windows: [] };
      machine.sessions.set(window.sessionId, session);
    }
    session.windows.push(window);
  }
  return [...machines.values()].map((machine) => ({
    ...machine,
    sessions: [...machine.sessions.values()],
  }));
}

/** A catalog's first agent is not evidence of actual terminal focus. */
export function selectedSidebarPane(paneIds: readonly string[], focused: string): string {
  return paneIds.includes(focused) ? focused : "";
}
