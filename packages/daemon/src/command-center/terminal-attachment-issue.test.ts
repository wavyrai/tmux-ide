import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TERMINAL_ATTACHMENT_ISSUE_PATH,
  TerminalAttachmentIssueResultSchemaZ,
  type DesktopDaemonHostState,
  type TerminalAttachmentIssueMutationRequest,
} from "@tmux-ide/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DaemonResourceBroker } from "../../../../apps/electron-shell/src/daemon-resource-broker.ts";
import { WorkspaceRegistry } from "../lib/workspace-registry.ts";
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
  const root = mkdtempSync(join(tmpdir(), "tmux-ide-terminal-issue-route-"));
  roots.push(root);
  const result = new WorkspaceRegistry({ dir: join(root, "registry"), listSessions: () => [] });
  result.add({ name: "product", sessionName: "product-runtime", projectDir: root });
  return result;
}

function mutation(
  overrides: Partial<TerminalAttachmentIssueMutationRequest> = {},
): TerminalAttachmentIssueMutationRequest {
  return {
    requestId: REQUEST_ID,
    expectedDaemonInstanceId: IDENTITY.instanceId,
    attachment: {
      protocolVersion: 1,
      target: { workspaceName: "product", semanticPaneId: "pane.worker" },
      viewerMode: "interactive",
      viewport: { cols: 120, rows: 40 },
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
    ...overrides,
  });
}

function appWith(backend: { issue: ReturnType<typeof vi.fn> }) {
  return createApp({
    authConfig: { method: "ssh", token_expiry: 86_400 },
    daemonIdentity: IDENTITY,
    workspaceRegistry: registry(),
    terminalAttachmentIssueBackend: backend,
    remoteAccess: {
      bindHostname: "0.0.0.0",
      token: REMOTE_TOKEN,
      localBypassToken: OWNER_TOKEN,
      ownerToken: OWNER_TOKEN,
    },
  });
}

async function parsed(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return TerminalAttachmentIssueResultSchemaZ.parse(await response.json());
}

describe("owner terminal attachment issue route", () => {
  it("interoperates with the Electron broker and projects only the strict shared descriptor", async () => {
    const now = 1_784_662_800_000;
    const issue = vi.fn(async () => ({
      protocolVersion: 1 as const,
      webSocketUrl: "ws://127.0.0.1:6060/v1/terminal/attachments/redeem",
      redemptionTicket: `ta1_${"A".repeat(43)}`,
      daemonInstanceId: IDENTITY.instanceId,
      requestId: REQUEST_ID,
      expiresAt: now + 30_000,
      effectiveViewerMode: "interactive" as const,
    }));
    const app = appWith({ issue });
    const connected: DesktopDaemonHostState = {
      status: "connected",
      descriptor: { apiBaseUrl: "http://127.0.0.1:6060", ...IDENTITY },
    };
    const brokerRequestUrls: string[] = [];
    const broker = new DaemonResourceBroker({
      daemon: connected,
      ownerToken: OWNER_TOKEN,
      now: () => now,
      fetch: async (input, init) => {
        brokerRequestUrls.push(input.toString());
        return app.fetch(new Request(input, init));
      },
    });

    await expect(broker.issueTerminalAttachment(mutation(), ORIGIN)).resolves.toEqual({
      status: "issued",
      descriptor: {
        protocolVersion: 1,
        webSocketUrl: "ws://127.0.0.1:6060/v1/terminal/attachments/redeem",
        subprotocol: "tmux-ide-terminal.v1",
        redemptionTicket: `ta1_${"A".repeat(43)}`,
        daemonInstanceId: IDENTITY.instanceId,
        requestId: REQUEST_ID,
        expiresAt: now + 30_000,
        effectiveViewerMode: "interactive",
      },
    });
    expect(issue).toHaveBeenCalledWith(mutation().attachment, {
      requestId: REQUEST_ID,
      projectIdentity: "product",
      rendererOrigin: ORIGIN,
    });
    expect(brokerRequestUrls).toEqual([
      `${connected.descriptor.apiBaseUrl}${TERMINAL_ATTACHMENT_ISSUE_PATH}`,
    ]);
  });

  it.each([
    ["missing owner bearer", { Authorization: "" }, TERMINAL_ATTACHMENT_ISSUE_PATH],
    ["remote bearer", { Authorization: `Bearer ${REMOTE_TOKEN}` }, TERMINAL_ATTACHMENT_ISSUE_PATH],
    [
      "query owner token",
      { Authorization: "" },
      `${TERMINAL_ATTACHMENT_ISSUE_PATH}?token=${OWNER_TOKEN}`,
    ],
    [
      "query remote token",
      { Authorization: "" },
      `${TERMINAL_ATTACHMENT_ISSUE_PATH}?token=${REMOTE_TOKEN}`,
    ],
    ["missing Origin", { Origin: "" }, TERMINAL_ATTACHMENT_ISSUE_PATH],
    ["opaque null Origin", { Origin: "null" }, TERMINAL_ATTACHMENT_ISSUE_PATH],
    ["file Origin", { Origin: "file://" }, TERMINAL_ATTACHMENT_ISSUE_PATH],
    [
      "wrong request correlation",
      { "X-Tmux-Ide-Request-Id": crypto.randomUUID() },
      TERMINAL_ATTACHMENT_ISSUE_PATH,
    ],
    ["wrong content type", { "Content-Type": "text/plain" }, TERMINAL_ATTACHMENT_ISSUE_PATH],
  ])("rejects %s without invoking admission", async (_label, overrides, path) => {
    const issue = vi.fn();
    const app = appWith({ issue });
    const result = await parsed(
      await app.request(path, {
        method: "POST",
        headers: headers(overrides),
        body: JSON.stringify(mutation()),
      }),
    );
    expect(result).toMatchObject({ status: "error" });
    expect(issue).not.toHaveBeenCalled();
  });

  it("accepts one exact canonical packaged application Origin", async () => {
    const issue = vi.fn(async () => ({
      protocolVersion: 1 as const,
      webSocketUrl: "ws://127.0.0.1:6060/v1/terminal/attachments/redeem",
      redemptionTicket: `ta1_${"A".repeat(43)}`,
      daemonInstanceId: IDENTITY.instanceId,
      requestId: REQUEST_ID,
      expiresAt: Date.now() + 30_000,
      effectiveViewerMode: "interactive" as const,
    }));
    const app = appWith({ issue });
    const packagedOrigin = "tmux-ide://app";
    const result = await parsed(
      await app.request(TERMINAL_ATTACHMENT_ISSUE_PATH, {
        method: "POST",
        headers: headers({ Origin: packagedOrigin }),
        body: JSON.stringify(mutation()),
      }),
    );
    expect(result).toMatchObject({ status: "issued" });
    expect(issue).toHaveBeenCalledWith(
      mutation().attachment,
      expect.objectContaining({ rendererOrigin: packagedOrigin }),
    );
  });

  it("rejects duplicate Origin, extra body authority, and daemon generation mismatch", async () => {
    const issue = vi.fn();
    const app = appWith({ issue });
    const duplicateOrigin = headers();
    duplicateOrigin.append("Origin", ORIGIN);
    const extraAuthority = { ...mutation(), projectIdentity: "renderer-authored" };
    const differentInstance = crypto.randomUUID();

    const results = await Promise.all([
      app.request(TERMINAL_ATTACHMENT_ISSUE_PATH, {
        method: "POST",
        headers: duplicateOrigin,
        body: JSON.stringify(mutation()),
      }),
      app.request(TERMINAL_ATTACHMENT_ISSUE_PATH, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(extraAuthority),
      }),
      app.request(TERMINAL_ATTACHMENT_ISSUE_PATH, {
        method: "POST",
        headers: headers({ "X-Tmux-Ide-Expected-Daemon-Instance-Id": differentInstance }),
        body: JSON.stringify(mutation({ expectedDaemonInstanceId: differentInstance })),
      }),
    ]);
    await expect(parsed(results[0]!)).resolves.toMatchObject({
      status: "error",
      error: { code: "invalid-request" },
    });
    await expect(parsed(results[1]!)).resolves.toMatchObject({
      status: "error",
      error: { code: "invalid-request" },
    });
    await expect(parsed(results[2]!)).resolves.toMatchObject({
      status: "error",
      error: { code: "daemon-identity-mismatch" },
    });
    expect(issue).not.toHaveBeenCalled();
  });

  it("redacts backend failures and refuses a non-loopback descriptor", async () => {
    const rawSecret = `ta1_${"Z".repeat(43)}`;
    const failing = appWith({
      issue: vi.fn(async () => {
        throw new Error(`Authorization: Bearer owner ${rawSecret}`);
      }),
    });
    const invalidDescriptor = appWith({
      issue: vi.fn(async () => ({
        protocolVersion: 1 as const,
        webSocketUrl: "ws://192.0.2.10:6060/v1/terminal/attachments/redeem",
        redemptionTicket: `ta1_${"A".repeat(43)}`,
        daemonInstanceId: IDENTITY.instanceId,
        requestId: REQUEST_ID,
        expiresAt: Date.now() + 30_000,
        effectiveViewerMode: "interactive" as const,
      })),
    });
    for (const app of [failing, invalidDescriptor]) {
      const response = await app.request(TERMINAL_ATTACHMENT_ISSUE_PATH, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(mutation()),
      });
      const text = await response.text();
      expect(TerminalAttachmentIssueResultSchemaZ.parse(JSON.parse(text))).toMatchObject({
        status: "error",
        error: { code: "attachment-unavailable" },
      });
      expect(text).not.toContain(rawSecret);
      expect(text).not.toMatch(/Authorization|Bearer|192\.0\.2\.10/iu);
    }
  });
});
