import type { Hono } from "hono";

import type { DaemonInstanceIdentity } from "@tmux-ide/contracts";

import type { WorkspaceRegistry } from "../../lib/workspace-registry.ts";
import { readAdoptedFleet } from "../discovery.ts";
import { ownerAuthorityGate } from "../owner-authority.ts";
import { projectFleetCatalog } from "./fleet-catalog.ts";

export interface FleetResourceRouteOptions {
  readonly daemon: DaemonInstanceIdentity;
  /** Owner-only capability. Never the remote-access or local-bypass token. */
  readonly ownerToken: string | null;
  /** Source of truth for which sessions the app created (`appCreated`). */
  readonly registry: Pick<WorkspaceRegistry, "list">;
  /** Daemon-generation-pinned tmux fleet read. Defaults only for legacy/test callers. */
  readonly readFleet?: () => ReturnType<typeof readAdoptedFleet>;
}

/**
 * Mounts the owner-only, generation-stamped fleet-catalog read resource.
 *
 * `GET /api/resources/fleet-catalog` enumerates every ADOPTED tmux session
 * (registry-backed OR adopted-only) and the coding agents inside it, projected
 * through the pure {@link projectFleetCatalog}. It degrades honestly: a tmux
 * failure returns a valid empty catalog rather than a 500 that could leak
 * internals, and fleet-scale caps trim an oversized fleet to the contract
 * ceiling. The resource is path-free by construction — no pane id, session name
 * or absolute path ever crosses the wire.
 */
export function mountFleetResourceRoute(app: Hono, options: FleetResourceRouteOptions): void {
  // Owner-only. Without the credential the fleet cannot be answered at all.
  const authorize = ownerAuthorityGate(options.ownerToken, {
    whenOwnerless: "unavailable",
    unavailableMessage: "Fleet catalog capability is unavailable",
    mismatchMessage: "Fleet catalog access requires owner authority",
  });

  app.get("/api/resources/fleet-catalog", (c) => {
    const gate = authorize(c);
    if (gate) return gate;

    // A tmux failure (null read) or any projection error degrades to a valid,
    // empty, still-stamped resource — never a 500 exposing daemon internals.
    let sessions: ReturnType<typeof readAdoptedFleet>;
    try {
      sessions = options.readFleet ? options.readFleet() : readAdoptedFleet(options.registry);
    } catch {
      sessions = null;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    let resource;
    try {
      resource = projectFleetCatalog(sessions ?? [], options.daemon, nowSec);
    } catch {
      resource = projectFleetCatalog([], options.daemon, nowSec);
    }
    c.header("Cache-Control", "no-store");
    return c.json(resource);
  });
}
