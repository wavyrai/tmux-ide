import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PANE_STREAM_ISSUE_PATH,
  PANE_STREAM_REDEEM_PATH,
  PaneStreamIssueResultSchemaZ,
  type PaneStreamIssueMutationRequest,
} from "@tmux-ide/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkspaceRegistry } from "../lib/workspace-registry.ts";
import { PaneStreamLeaseError } from "../terminal/pane-stream/lease-manager.ts";
import { PaneStreamAdmissionError } from "../terminal/pane-stream/pane-stream-websocket.ts";
import { createApp } from "./server.ts";

const IDENTITY = {
  protocolVersion: 1,
  productVersion: "2.8.0",
  instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
  startedAt: "2026-07-21T00:00:00.000Z",
} as const;
const OWNER_TOKEN = "owner-only-token";
const REMOTE_TOKEN = "remotely-shared-token";
const ORIGIN = "http://127.0.0.1:5173";
const REQUEST_ID = "10000000-0000-4000-8000-000000000001";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function registry(): WorkspaceRegistry {
  const root = mkdtempSync(join(tmpdir(), "tmux-ide-pane-stream-issue-route-"));
  roots.push(root);
  const result = new WorkspaceRegistry({ dir: join(root, "registry"), listSessions: () => [] });
  result.add({ name: "product", sessionName: "product-runtime", projectDir: root });
  return result;
}

function mutation(
  overrides: Partial<PaneStreamIssueMutationRequest> = {},
): PaneStreamIssueMutationRequest {
  return {
    requestId: REQUEST_ID,
    expectedDaemonInstanceId: IDENTITY.instanceId,
    stream: {
      protocolVersion: 1,
      workspaceName: "product",
      panes: ["pane.worker", "pane.logs"],
      viewerMode: "interactive",
    },
    ...overrides,
  };
}

function headers(overrides: Record<string, string> = {}): Headers {
  return new Headers({
    Authorization: `Bearer ${OWNER_TOKEN}`,
    "Content-Type": "application/json",
    Origin: ORIGIN,
    "X-Tmux-Ide-Request-Id": REQUEST_ID,
    "X-Tmux-Ide-Expected-Daemon-Instance-Id": IDENTITY.instanceId,
    "X-Tmux-Ide-Host-Client-Id": "electron:test-renderer",
    ...overrides,
  });
}

function appWith(backend: { issue: ReturnType<typeof vi.fn> } | null) {
  return createApp({
    authConfig: { method: "ssh", token_expiry: 86_400 },
    daemonIdentity: IDENTITY,
    workspaceRegistry: registry(),
    paneStreamIssueBackend: backend,
    remoteAccess: {
      bindHostname: "0.0.0.0",
      token: REMOTE_TOKEN,
      localBypassToken: OWNER_TOKEN,
      ownerToken: OWNER_TOKEN,
    },
  });
}

function post(app: ReturnType<typeof createApp>, body: unknown, headerOverrides = {}) {
  return app.request(PANE_STREAM_ISSUE_PATH, {
    method: "POST",
    headers: headers(headerOverrides),
    body: JSON.stringify(body),
  });
}

async function parsed(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return PaneStreamIssueResultSchemaZ.parse(await response.json());
}

function descriptor() {
  return {
    protocolVersion: 1 as const,
    webSocketUrl: `ws://127.0.0.1:6060${PANE_STREAM_REDEEM_PATH}`,
    redemptionTicket: `ps1_${"A".repeat(43)}`,
    daemonInstanceId: IDENTITY.instanceId,
    requestId: REQUEST_ID,
    expiresAt: 1_784_662_830_000,
    panes: ["pane.worker", "pane.logs"],
    effectiveViewerMode: "interactive" as const,
  };
}

describe("owner pane-stream issue route", () => {
  it("issues with the owner bearer, forwarding daemon-resolved workspace identity", async () => {
    const issue = vi.fn(async () => descriptor());
    const app = appWith({ issue });
    const result = await parsed(await post(app, mutation()));
    expect(result.status).toBe("issued");
    if (result.status === "issued") {
      expect(result.descriptor.subprotocol).toBe("tmux-ide-pane-stream.v1");
      expect(result.descriptor.panes).toEqual(["pane.worker", "pane.logs"]);
    }
    expect(issue).toHaveBeenCalledWith(
      mutation().stream,
      expect.objectContaining({
        requestId: REQUEST_ID,
        projectIdentity: "product",
        sessionName: "product-runtime",
        rendererOrigin: ORIGIN,
      }),
    );
  });

  it("rejects the remote access token and missing owner bearer", async () => {
    const issue = vi.fn(async () => descriptor());
    const app = appWith({ issue });
    for (const authorization of [`Bearer ${REMOTE_TOKEN}`, ""]) {
      const result = await parsed(await post(app, mutation(), { Authorization: authorization }));
      expect(result.status).toBe("error");
      if (result.status === "error") expect(result.error.code).toBe("invalid-request");
    }
    expect(issue).not.toHaveBeenCalled();
  });

  it("rejects a daemon generation mismatch and unknown workspaces", async () => {
    const issue = vi.fn(async () => descriptor());
    const app = appWith({ issue });
    const mismatch = await parsed(
      await post(
        app,
        mutation({ expectedDaemonInstanceId: "00000000-0000-4000-8000-00000000dead" }),
        { "X-Tmux-Ide-Expected-Daemon-Instance-Id": "00000000-0000-4000-8000-00000000dead" },
      ),
    );
    expect(mismatch.status === "error" && mismatch.error.code).toBe("daemon-identity-mismatch");
    const missing = await parsed(
      await post(app, mutation({ stream: { ...mutation().stream, workspaceName: "ghost" } })),
    );
    expect(missing.status === "error" && missing.error.code).toBe("workspace-not-found");
    expect(issue).not.toHaveBeenCalled();
  });

  it("maps backend conflicts and admission failures to renderer-safe errors", async () => {
    const conflictApp = appWith({
      issue: vi.fn(async () => {
        throw new PaneStreamLeaseError("interactive-viewer-conflict", "owned");
      }),
    });
    const conflict = await parsed(await post(conflictApp, mutation()));
    expect(conflict.status === "error" && conflict.error.code).toBe("interactive-viewer-conflict");

    const paneApp = appWith({
      issue: vi.fn(async () => {
        throw new PaneStreamAdmissionError("pane-not-found", "gone");
      }),
    });
    const pane = await parsed(await post(paneApp, mutation()));
    expect(pane.status === "error" && pane.error.code).toBe("pane-not-found");

    const nullApp = appWith(null);
    const unavailable = await parsed(await post(nullApp, mutation()));
    expect(unavailable.status === "error" && unavailable.error.code).toBe("daemon-unavailable");

    // The merged vocabulary's word for it: capacity exhaustion is reported the
    // same way whichever lease family asked (m45 — was `stream-unavailable`).
    const capacityApp = appWith({
      issue: vi.fn(async () => {
        throw new PaneStreamAdmissionError("live-capacity-exhausted", "full");
      }),
    });
    const capacity = await parsed(await post(capacityApp, mutation()));
    expect(capacity.status === "error" && capacity.error.code).toBe("attachment-unavailable");
  });

  it("rejects malformed envelopes and query strings", async () => {
    const issue = vi.fn(async () => descriptor());
    const app = appWith({ issue });
    const malformed = await parsed(
      await post(app, { ...mutation(), stream: { ...mutation().stream, viewport: { cols: 1 } } }),
    );
    expect(malformed.status === "error" && malformed.error.code).toBe("invalid-request");
    const withQuery = await app.request(`${PANE_STREAM_ISSUE_PATH}?token=x`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(mutation()),
    });
    const query = await parsed(withQuery);
    expect(query.status === "error" && query.error.code).toBe("invalid-request");
    expect(issue).not.toHaveBeenCalled();
  });
});
