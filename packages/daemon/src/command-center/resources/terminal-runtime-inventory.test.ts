import { describe, expect, it, vi } from "vitest";
import { createServer, request } from "node:http";
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
