import { render } from "solid-js/web";

import { FleetSidebarSection } from "./fleet-sidebar.tsx";
import type { DesktopFleetCatalogState } from "../runtime/fleet-catalog-store.ts";
import { FLEET_FIXTURE_DAEMON, mixedFleetCatalog } from "../runtime/fleet-catalog-fixture.ts";

/**
 * Real-browser strict-CSP fixtures for the fleet sidebar. Never mounted by the
 * product shell — the CSP smoke and screenshot harness import these to render
 * the mixed / empty / unavailable scenarios against the packaged stylesheet.
 */

const DAEMON = FLEET_FIXTURE_DAEMON;

const MIXED_STATE: DesktopFleetCatalogState = {
  status: "live",
  generation: 1,
  daemon: DAEMON,
  snapshot: { daemon: DAEMON, catalog: mixedFleetCatalog(), updatedAt: 0 },
};

const EMPTY_STATE: DesktopFleetCatalogState = {
  status: "live",
  generation: 1,
  daemon: DAEMON,
  snapshot: {
    daemon: DAEMON,
    catalog: { version: 1, daemon: DAEMON, sessions: [] },
    updatedAt: 0,
  },
};

const UNAVAILABLE_STATE: DesktopFleetCatalogState = {
  status: "degraded",
  generation: 1,
  daemon: DAEMON,
  snapshot: null,
  code: "daemon-unavailable",
  reason: "The canonical daemon is unavailable.",
};

/** Mount the mixed fleet with the open workspace marked. */
export function mountFleetSidebarSmokeFixture(root: HTMLElement): () => void {
  return render(
    () => (
      <aside class="workspace-sidebar" style={{ width: "236px" }}>
        <FleetSidebarSection
          state={MIXED_STATE}
          openSessionId="session.aaaaaaaaaaaaaaaa"
          onPromote={async () => ({ ok: true })}
        />
      </aside>
    ),
    root,
  );
}

/** Mount the empty and unavailable states side by side for the honest-state screenshot. */
export function mountFleetSidebarStatesSmokeFixture(root: HTMLElement): () => void {
  return render(
    () => (
      <div style={{ display: "flex", gap: "16px" }}>
        <aside class="workspace-sidebar" style={{ width: "236px" }}>
          <FleetSidebarSection state={EMPTY_STATE} onPromote={async () => ({ ok: true })} />
        </aside>
        <aside class="workspace-sidebar" style={{ width: "236px" }}>
          <FleetSidebarSection state={UNAVAILABLE_STATE} onPromote={async () => ({ ok: true })} />
        </aside>
      </div>
    ),
    root,
  );
}
