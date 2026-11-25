import { describe, expect, it, vi } from "vitest";
import { createServer, request } from "node:http";
import { projectTerminalRuntimeInventoryV2 } from "./terminal-runtime-inventory.ts";
import { getRequestListener } from "@hono/node-server";

import { TerminalRuntimeInventoryResourceV1SchemaZ } from "@tmux-ide/contracts";
import { createApp } from "../server.ts";
import type { NativeTerminalRuntimeSessionSnapshot } from "../../terminal/attachments/native-runtime.ts";

const session: NativeTerminalRuntimeSessionSnapshot = {
  workspaceName: "workspace.alpha",
  name: "runtime:alpha",
  runtimeSessionId: "$7",
  dir: "/Users/private/project",
  catalogIssue: null,
  panes: [
    {
      windowId: "@1",
      runtimePaneId: "%3",
      windowPaneCount: 1,
      semanticPaneId: "pane.alpha",
      windowStamp: null,
      index: 0,
      title: "Alpha",
      currentCommand: "zsh",
      active: true,
      role: null,
      name: null,
      type: null,
      missionStamp: null,
    },
  ],
};

describe("terminal runtime inventory resource", () => {
  it("is owner-only, agent-free, and never serializes raw tmux/path facts", async () => {
    const order: string[] = [];
    const discover = vi.fn(async () => {
      order.push("discover");
      return session;
    });
    const app = createApp({
      remoteAccess: {
        bindHostname: "127.0.0.1",
        ownerToken: "owner-secret",
      },
      daemonIdentity: {
        productVersion: "2.8.0",
        instanceId: "11111111-1111-4111-8111-111111111111",
        startedAt: "2026-08-17T10:00:00.000Z",
      },
      applicationShellInventoryBackend: {
        discoverApplicationShellSession: async () => null,
        discoverTerminalRuntimeSession: discover,
        recordTerminalRuntimeResourceMark: (operation) => {
          order.push(operation);
          throw new Error("diagnostic sink failed");
        },
      },
    });
    const path = "/api/project/runtime%3Aalpha/terminal-runtime-inventory?version=1";
    expect((await app.request(path)).status).toBe(401);
    expect((await app.request(path, { headers: { Authorization: "Bearer wrong" } })).status).toBe(
      401,
    );
    const response = await app.request(path, {
      headers: { Authorization: "Bearer owner-secret" },
    });
    expect(response.status).toBe(200);
    const body = TerminalRuntimeInventoryResourceV1SchemaZ.parse(await response.json());
    expect(body.resource).toMatchObject({
      workspaceName: "workspace.alpha",
      resourceRevision: 0,
      semanticPaneIds: ["pane.alpha"],
    });
    const encoded = JSON.stringify(body);
    expect(encoded).not.toContain("$7");
    expect(encoded).not.toContain("%3");
    expect(encoded).not.toContain("/Users/private");
    expect(discover).toHaveBeenCalledWith("runtime:alpha", expect.anything());
    expect(discover.mock.calls[0]![1]).toBeInstanceOf(AbortSignal);
    expect(discover.mock.calls[0]![1]!.aborted).toBe(false);
    expect(order).toEqual([
      "terminal-resource-handler-admitted",
      "discover",
      "terminal-resource-response-projection",
    ]);
  });

  it("aborts a pending authority read with the HTTP request and never projects its late result", async () => {
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => (started = resolve));
    let release!: (value: NativeTerminalRuntimeSessionSnapshot) => void;
    const late = new Promise<NativeTerminalRuntimeSessionSnapshot>(
      (resolve) => (release = resolve),
    );
    let observedSignal: AbortSignal | undefined;
    const app = createApp({
      remoteAccess: { ownerToken: "owner-secret" },
      applicationShellInventoryBackend: {
        discoverApplicationShellSession: async () => null,
        discoverTerminalRuntimeSession: (_name, signal) => {
          observedSignal = signal;
          started();
          return new Promise((resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            void late.then(resolve);
          });
        },
      },
    });
    const abort = new AbortController();
    const pending = app.request(
      new Request(
        "http://localhost/api/project/runtime%3Aalpha/terminal-runtime-inventory?version=1",
        {
          headers: { Authorization: "Bearer owner-secret" },
          signal: abort.signal,
        },
      ),
    );
    await didStart;
    abort.abort(new DOMException("request closed", "AbortError"));
    expect((await pending).status).toBe(503);
    expect(observedSignal?.aborted).toBe(true);
    release(session);
    await Promise.resolve();
    expect((await pending).status).toBe(503);
  });

  it("receives an aborted request signal when the production Node client socket closes", async () => {
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => (started = resolve));
    let aborted!: () => void;
    const didAbort = new Promise<void>((resolve) => (aborted = resolve));
    const app = createApp({
      remoteAccess: { ownerToken: "owner-secret" },
      applicationShellInventoryBackend: {
        discoverApplicationShellSession: async () => null,
        discoverTerminalRuntimeSession: (_name, signal) =>
          new Promise((_resolve, reject) => {
            started();
            signal?.addEventListener(
              "abort",
              () => {
                aborted();
                reject(signal.reason);
              },
              { once: true },
            );
          }),
      },
    });
    const server = createServer(getRequestListener(app.fetch));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
    const client = request({
      host: "127.0.0.1",
      port: address.port,
      path: "/api/project/runtime%3Aalpha/terminal-runtime-inventory?version=1",
      headers: { Authorization: "Bearer owner-secret" },
    });
    client.on("error", () => undefined);
    client.end();
    await didStart;
    client.destroy();
    await didAbort;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("fails closed when terminal authority is not available", async () => {
    const app = createApp({ remoteAccess: { ownerToken: "owner-secret" } });
    const response = await app.request("/api/project/alpha/terminal-runtime-inventory?version=1", {
      headers: { Authorization: "Bearer owner-secret" },
    });
    expect(response.status).toBe(503);
  });
});

describe("terminal runtime inventory version 2 (#806)", () => {
  const pane = (
    windowId: string,
    runtimePaneId: string,
    semanticPaneId: string | null,
    windowStamp: string | null,
    windowPaneCount: number,
    active = false,
  ) => ({
    windowId,
    runtimePaneId,
    windowPaneCount,
    semanticPaneId,
    windowStamp,
    index: 0,
    title: "t",
    currentCommand: "zsh",
    active,
    role: null,
    name: null,
    type: null,
    missionStamp: null,
  });
  const windowed: NativeTerminalRuntimeSessionSnapshot = {
    ...session,
    panes: [
      pane("@1", "%1", "pane.one", "window.one", 2),
      pane("@1", "%2", "pane.two", "window.one", 2),
      pane("@2", "%3", "pane.three", "window.two", 1, true),
      // A two-pane window with an unstamped pane: its panes are unavailable.
      pane("@3", "%4", "pane.four", "window.three", 2),
      pane("@3", "%5", "pane.five", null, 2),
      // A stamped window with one pane unavailable (no pane stamp): not issuable as a window.
      pane("@5", "%7", "pane.seven", "window.five", 2),
      pane("@5", "%8", null, "window.five", 2),
      // A single-pane window without a window stamp: available, but no window to name.
      pane("@4", "%6", "pane.six", null, 1),
    ],
  };

  it("lists each verified window with its available panes, in tmux order", () => {
    const projected = projectTerminalRuntimeInventoryV2(windowed, 3);
    expect(projected.semanticPaneIds).toEqual([
      "pane.one",
      "pane.seven",
      "pane.six",
      "pane.three",
      "pane.two",
    ]);
    expect(projected.windows).toEqual([
      { semanticWindowId: "window.one", active: false, semanticPaneIds: ["pane.one", "pane.two"] },
      { semanticWindowId: "window.two", active: true, semanticPaneIds: ["pane.three"] },
    ]);
    expect(JSON.stringify(projected)).not.toMatch(/@\d|%\d/u);
  });

  it("names no window when the session has a catalog issue", () => {
    expect(
      projectTerminalRuntimeInventoryV2({ ...windowed, catalogIssue: "missing-semantic-stamp" }, 0)
        .windows,
    ).toEqual([]);
  });
});

describe("terminal runtime inventory with floating panes (#882)", () => {
  const pane = (
    runtimePaneId: string,
    semanticPaneId: string,
    active: boolean,
    floating = false,
  ) => ({
    windowId: "@1",
    runtimePaneId,
    windowPaneCount: 3,
    semanticPaneId,
    windowStamp: "window.one",
    index: 0,
    title: "t",
    currentCommand: "zsh",
    active,
    role: null,
    name: null,
    type: null,
    missionStamp: null,
    ...(floating ? { floating: true } : {}),
  });

  it("attaches the tiled panes only, and an active float keeps its window active", () => {
    const projected = projectTerminalRuntimeInventoryV2(
      {
        ...session,
        panes: [
          pane("%1", "pane.one", false),
          pane("%2", "pane.two", false),
          pane("%3", "pane.float", true, true),
        ],
      },
      0,
    );
    expect(projected.semanticPaneIds).toEqual(["pane.one", "pane.two"]);
    expect(projected.windows).toEqual([
      { semanticWindowId: "window.one", active: true, semanticPaneIds: ["pane.one", "pane.two"] },
    ]);
  });
});
