import { createSignal, onCleanup, type Accessor } from "solid-js";

import type { TuiApplicationLifecycle } from "./application-lifecycle.ts";
import {
  createApplicationHomeCatalog,
  moveHomeCatalogSelection,
  selectedHomeCatalogIndex,
  type ApplicationHomeCatalog,
} from "./application-home-catalog.ts";

export interface ApplicationHomeCatalogOwner {
  readonly sessionNames: Accessor<readonly string[]>;
  readonly selectedSessionIndex: Accessor<number>;
  readonly note: Accessor<string | null>;
  readonly start: () => void;
  readonly handleKey: (name: string) => boolean;
}

export interface ApplicationHomeCatalogOwnerOptions {
  readonly lifecycle: Pick<TuiApplicationLifecycle, "registerCloser">;
  readonly automaticOpen: boolean;
  readonly startGeneration: (sessionName: string) => Promise<unknown> | void;
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
    sessionNames,
    selectedSessionIndex,
    note: () => snapshot().note,
    start: () => catalog.start(),
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
