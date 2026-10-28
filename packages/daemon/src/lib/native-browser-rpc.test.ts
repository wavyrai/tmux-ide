import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:net";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeBrowserRpc, type NativeBrowserEndpoint } from "./native-browser-rpc.ts";

const instance = "12345678-1234-4234-8234-123456789abc";
const state = {
  version: 1 as const,
  instance,
  pane: "%1",
  tab: 1,
  revision: 1,
  enabled: true,
  url: "https://example.com",
  title: "Example",
  loading: false,
  canGoBack: false,
  canGoForward: false,
};
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const run of cleanup.splice(0)) await run();
});
async function fixture(reply: (request: Record<string, unknown>) => unknown) {
  const dir = await mkdtemp(join(tmpdir(), "tmi-browser-rpc-"));
  const socket = join(dir, "browser.sock");
  const requests: Record<string, unknown>[] = [];
  const server: Server = createServer((connection) => {
    let data = "";
    connection.on("error", () => {});
    connection.on("data", (chunk) => {
      data += chunk.toString();
      if (!data.endsWith("\n")) return;
      const request = JSON.parse(data) as Record<string, unknown>;
      requests.push(request);
      connection.end(JSON.stringify(reply(request)) + "\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  await chmod(socket, 0o600);
  cleanup.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const endpoint: NativeBrowserEndpoint = {
    version: 1,
    pid: process.pid,
    instance,
    pane: "%1",
    socket,
  };
  return { endpoint, requests };
}
describe("native browser RPC", () => {
  it("reads only the advertised instance and sends a mutation exactly once", async () => {
    const f = await fixture((request) => ({ id: request.id, ok: true, data: state }));
    expect(await nativeBrowserRpc(f.endpoint, null, AbortSignal.timeout(2000))).toEqual(state);
    await nativeBrowserRpc(
      f.endpoint,
      { version: 1, instance, pane: "%1", tab: 1, revision: 1, action: "reload" },
      AbortSignal.timeout(2000),
    );
    expect(f.requests.map((r) => r.cmd)).toEqual(["native/1/state", "native/1/command"]);
  });
  it("rejects replaced instances, unrelated panes and mismatched correlation", async () => {
    for (const change of [{ instance: "22345678-1234-4234-8234-123456789abc" }, { pane: "%2" }]) {
      const f = await fixture((request) => ({
        id: request.id,
        ok: true,
        data: { ...state, ...change },
      }));
      await expect(nativeBrowserRpc(f.endpoint, null, AbortSignal.timeout(2000))).rejects.toThrow();
    }
    const f = await fixture(() => ({ id: "wrong", ok: true, data: state }));
    await expect(nativeBrowserRpc(f.endpoint, null, AbortSignal.timeout(2000))).rejects.toThrow();
  });
  it("does not retry a refused mutation", async () => {
    const f = await fixture((request) => ({
      id: request.id,
      ok: false,
      error: "browser target changed",
    }));
    await expect(
      nativeBrowserRpc(
        f.endpoint,
        { version: 1, instance, pane: "%1", tab: 1, revision: 1, action: "stop" },
        AbortSignal.timeout(2000),
      ),
    ).rejects.toThrow();
    expect(f.requests).toHaveLength(1);
  });
  it("refuses shared writable endpoints and cancelled requests before sending", async () => {
    const f = await fixture((request) => ({ id: request.id, ok: true, data: state }));
    await chmod(f.endpoint.socket, 0o666);
    await expect(nativeBrowserRpc(f.endpoint, null, AbortSignal.timeout(2000))).rejects.toThrow();
    await chmod(f.endpoint.socket, 0o600);
    await expect(nativeBrowserRpc(f.endpoint, null, AbortSignal.abort())).rejects.toThrow();
    expect(f.requests).toHaveLength(0);
  });
});
