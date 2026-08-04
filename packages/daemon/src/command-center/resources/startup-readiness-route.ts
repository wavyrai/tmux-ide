import { timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";

import {
  STARTUP_READINESS_RESOURCE_VERSION,
  buildStartupReadinessLadder,
  type DaemonInstanceIdentity,
  type DesktopDaemonHostIssueCode,
  type StartupReadinessLadder,
  type StartupReadinessResource,
} from "@tmux-ide/contracts";

import { inspectCanonicalDaemonInfo } from "../../canonical.ts";
import type { WorkspaceRegistry } from "../../lib/workspace-registry.ts";
import type { NativeTerminalInventorySnapshot } from "../../terminal/attachments/native-runtime.ts";
import {
  projectStartupReadinessLadder,
  summarizeStartupReadinessCatalog,
  type StartupReadinessCatalogFacts,
} from "./startup-readiness.ts";

/** The narrow slice of the attachment runtime readiness needs. */
export interface StartupReadinessAttachmentAuthority {
  discoverTerminalInventory(): Promise<NativeTerminalInventorySnapshot>;
  lifecycleState(): "initializing" | "ready" | "failed" | "disposing" | "disposed";
}

export interface StartupReadinessRouteOptions {
  readonly daemon: DaemonInstanceIdentity;
  /** Owner-only capability. Never the remote-access or local-bypass token. */
  readonly ownerToken: string | null;
  readonly registry: Pick<WorkspaceRegistry, "list">;
  /** Absent when this daemon generation has no attachment runtime. */
  readonly attachmentRuntime: StartupReadinessAttachmentAuthority | null;
  /** Seam for tests; production reads the real canonical record. */
  readonly inspectCanonical?: typeof inspectCanonicalDaemonInfo;
  readonly now?: () => number;
}

function bearerMatches(header: string | undefined, ownerToken: string | null): boolean {
  if (!header || !ownerToken) return false;
  const supplied = Buffer.from(header, "utf8");
  const expected = Buffer.from(`Bearer ${ownerToken}`, "utf8");
  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
}

/**
 * Does the canonical record still describe THIS daemon generation? A record
 * that went missing, went corrupt, or now names another instance is exactly the
 * identity failure the desktop hits, so it is reported with the host-issue
 * vocabulary that already names those cases.
 */
function identityFacts(options: StartupReadinessRouteOptions): {
  readonly identity: DaemonInstanceIdentity | null;
  readonly code: DesktopDaemonHostIssueCode | null;
} {
  const inspect = options.inspectCanonical ?? inspectCanonicalDaemonInfo;
  let state: ReturnType<typeof inspectCanonicalDaemonInfo>;
  try {
    state = inspect();
  } catch {
    return { identity: null, code: "record-invalid" };
  }
  if (state.status === "missing") return { identity: null, code: "record-missing" };
  if (state.status !== "valid") return { identity: null, code: "record-invalid" };
  if (state.info.instanceId !== options.daemon.instanceId) {
    return { identity: null, code: "identity-mismatch" };
  }
  return { identity: options.daemon, code: null };
}

async function catalogFacts(
  options: StartupReadinessRouteOptions,
): Promise<StartupReadinessCatalogFacts | null> {
  const runtime = options.attachmentRuntime;
  if (!runtime) return null;
  let workspaceCount: number;
  try {
    workspaceCount = options.registry.list().length;
  } catch {
    return { status: "discovery-failed" };
  }
  try {
    const inventory = await runtime.discoverTerminalInventory();
    return summarizeStartupReadinessCatalog(inventory, workspaceCount);
  } catch {
    // A dead tmux socket lands here. The ladder reports it; the endpoint keeps
    // serving — readiness must never take down the thing it reports on.
    return { status: "discovery-failed" };
  }
}

/** Compute the whole ladder from state read at request time. Never throws. */
export async function readStartupReadinessLadder(
  options: StartupReadinessRouteOptions,
): Promise<StartupReadinessLadder> {
  const observedAt = new Date(options.now?.() ?? Date.now()).toISOString();
  try {
    if (!options.ownerToken) {
      return projectStartupReadinessLadder(
        { ownerCapability: false, identity: null, catalog: null, attachment: "unready" },
        observedAt,
      );
    }
    const identity = identityFacts(options);
    if (!identity.identity) {
      return buildStartupReadinessLadder(
        [
          { status: "satisfied" },
          { status: "satisfied" },
          {
            status: "stuck",
            reason: {
              vocabulary: "desktop-daemon-host-issue",
              code: identity.code ?? "record-invalid",
            },
          },
        ],
        observedAt,
      );
    }
    const catalog = await catalogFacts(options);
    const attachment =
      options.attachmentRuntime?.lifecycleState() === "ready" ? "ready" : "unready";
    return projectStartupReadinessLadder(
      { ownerCapability: true, identity: identity.identity, catalog, attachment },
      observedAt,
    );
  } catch {
    // Even a fault inside readiness itself is reported as a ladder, never a 500.
    return buildStartupReadinessLadder(
      [
        { status: "satisfied" },
        { status: "satisfied" },
        { status: "satisfied" },
        {
          status: "stuck",
          reason: { vocabulary: "startup-readiness", code: "catalog-discovery-failed" },
        },
      ],
      observedAt,
    );
  }
}

/**
 * Mounts the startup readiness ladder resource.
 *
 * `GET /api/resources/startup-readiness` answers the ordered rungs from state
 * read at request time: the owner capability, the canonical identity record,
 * a live semantic pane catalog pass, and the attachment runtime's own startup
 * barrier. Nothing is cached and nothing is assumed from a previous success.
 *
 * Authorization has one deliberate exception. Every other owner-gated resource
 * answers 503 when the daemon holds no owner capability; this one instead
 * serves a ladder whose `credential-held` rung is stuck, because "there is no
 * credential" is precisely the answer the caller is asking for — and the ladder
 * it gets back stops at that rung, carrying no fleet facts whatsoever.
 */
export function mountStartupReadinessRoute(app: Hono, options: StartupReadinessRouteOptions): void {
  const authorize = (c: Context): Response | null => {
    if (!options.ownerToken) return null;
    if (!bearerMatches(c.req.header("Authorization"), options.ownerToken)) {
      return c.json({ error: "Startup readiness access requires owner authority" }, 401);
    }
    return null;
  };

  app.get("/api/resources/startup-readiness", async (c) => {
    const gate = authorize(c);
    if (gate) return gate;
    const ladder = await readStartupReadinessLadder(options);
    c.header("Cache-Control", "no-store");
    return c.json({
      version: STARTUP_READINESS_RESOURCE_VERSION,
      daemon: options.daemon,
      ladder,
    } satisfies StartupReadinessResource);
  });
}
