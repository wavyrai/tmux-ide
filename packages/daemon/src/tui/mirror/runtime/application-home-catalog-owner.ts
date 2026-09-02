import { createSignal, onCleanup, type Accessor } from "solid-js";

import type { TuiApplicationLifecycle } from "./application-lifecycle.ts";
import {
  createApplicationHomeCatalog,
  moveHomeCatalogSelection,
  selectedHomeCatalogIndex,
  type ApplicationHomeCatalog,
  type ApplicationHomeCatalogSnapshot,
} from "./application-home-catalog.ts";
import { createFleetSession } from "./fleet-lifecycle-client.ts";

export interface ApplicationHomeCatalogOwner {
  readonly phase: Accessor<ApplicationHomeCatalogSnapshot["phase"]>;
  readonly sessionNames: Accessor<readonly string[]>;
  readonly selectedSessionIndex: Accessor<number>;
  readonly note: Accessor<string | null>;
  readonly start: () => void;
  readonly createLocalSession: () => Promise<void>;
  readonly handleKey: (name: string) => boolean;
}

export interface ApplicationHomeCatalogOwnerOptions {
  readonly lifecycle: Pick<TuiApplicationLifecycle, "registerCloser">;
  readonly automaticOpen: boolean;
  readonly startGeneration: (sessionName: string) => Promise<unknown> | void;
  readonly setNote?: (note: string | null) => void;
  readonly catalog?: ApplicationHomeCatalog;
}

/** Owns the post-mount Home catalog, its selection, and sole-session auto-open. */
export function createApplicationHomeCatalogOwner(
  options: ApplicationHomeCatalogOwnerOptions,
): ApplicationHomeCatalogOwner {
  const catalog = options.catalog ?? createApplicationHomeCatalog();
  const [snapshot, setSnapshot] = createSignal(catalog.getSnapshot());
  const sessions = () => snapshot().sessions;
  const sessionNames = () => sessions().map(({ name }) => name);
  const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>(null);
  const selectedSessionIndex = () => selectedHomeCatalogIndex(sessions(), selectedSessionId());
  let creatingLocalSession = false;
  const createLocalSession = async (): Promise<void> => {
    if (creatingLocalSession) return;
    creatingLocalSession = true;
    options.setNote?.("Creating tmux-ide-local…");
    try {
      const created = await createFleetSession({
        displayName: "tmux-ide-local",
        cwd: process.cwd(),
      });
      if (!created) throw new Error("The tmux-ide daemon is unavailable.");
      options.setNote?.(`Opening ${created.displayName}…`);
      await options.startGeneration(created.workspaceName);
    } catch (error) {
      options.setNote?.(
        error instanceof Error
          ? `Could not create a local session: ${error.message}`
          : "Could not create a local session.",
      );
    } finally {
      creatingLocalSession = false;
    }
  };
  let automaticOpen = options.automaticOpen;
  const stop = catalog.subscribe((next) => {
    setSnapshot(next);
    const current = selectedSessionId();
    const currentSessions = next.sessions;
    if (automaticOpen && next.phase === "live") {
      automaticOpen = false;
      if (currentSessions.length === 1) void options.startGeneration(currentSessions[0]!.name);
    }
    if (currentSessions.length === 0) {
      if (current !== null) setSelectedSessionId(null);
    } else if (!currentSessions.some(({ id }) => id === current)) {
      setSelectedSessionId(currentSessions[0]!.id);
    }
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    stop();
    catalog.dispose();
  };
  options.lifecycle.registerCloser("home-catalog", close);
  onCleanup(close);

  return Object.freeze({
    phase: () => snapshot().phase,
    sessionNames,
    selectedSessionIndex,
    note: () => snapshot().note,
    start: () => catalog.start(),
    createLocalSession,
    handleKey(name: string) {
      if (sessions().length === 0) return false;
      if (name === "up" || name === "down") {
        setSelectedSessionId((selected) =>
          moveHomeCatalogSelection(sessions(), selected, name === "up" ? -1 : 1),
        );
        return true;
      }
      if (name === "return" || name === "enter") {
        const sessionName = sessions()[selectedSessionIndex()]?.name;
        if (sessionName) void options.startGeneration(sessionName);
        return true;
      }
      return false;
    },
  });
}
