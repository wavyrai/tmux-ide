import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { mountTerminalNativeBackingRoute } from "./terminal-native-backing-route.ts";
import { decodeNativeGridCapture } from "../../terminal/mirror/native-grid-capture.ts";
import type { TerminalReplicaNativeBackingResult } from "../../terminal/session-runtime/terminal-replica-owner.ts";

const generation = "00000000-0000-4000-8000-000000000001";
const authority = {
  generation,
  workspaceName: "session",
  semanticPaneId: "pane",
  incarnation: "pane:0",
  revision: 4,
  stateHash: "hash",
};
const snapshot = decodeNativeGridCapture(
  '{"version":1,"cols":1,"rows":1,"history":0,"hscrolled":0,"limit":100,"cursor":[0,0]}\n{"row":0,"flags":0,"used":1,"cells":[[0,1,"41",0,8,8,8,0,0]]}\n',
)!;
function fixture(
  capture = vi.fn<() => Promise<TerminalReplicaNativeBackingResult>>(async () => ({
    status: "captured",
    authority,
    snapshot,
    isCurrent: () => true,
  })),
) {
  const app = new Hono();
  const resolveSession = vi.fn((workspace: string) =>
    workspace === "workspace" ? "session" : null,
  );
  mountTerminalNativeBackingRoute(app, {
    generation,
    ownerToken: "owner",
    resolveSession,
    capture,
  });
  const query = new URLSearchParams({
    generation,
    incarnation: authority.incarnation,
    revision: "4",
    stateHash: "hash",
  });
  const url = `/api/project/workspace/terminal-native-backing/pane?${query}`;
  const request = (path = url, token = "owner") =>
    app.request(path, { headers: { Authorization: `Bearer ${token}` } });
  return { app, request, url, capture, resolveSession };
}
describe("native backing owner read", () => {
  it("returns compact backing stamped with the exact requested identity", async () => {
    const { request } = fixture();
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.text();
    const newline = body.indexOf("\n");
    expect(JSON.parse(body.slice(0, newline))).toEqual({
      ...authority,
      workspaceName: "workspace",
    });
    expect(decodeNativeGridCapture(body.slice(newline + 1))).toEqual(snapshot);
  });
  it("rejects credentials, wrong generations and absent workspaces before capture", async () => {
    const { request, url, capture } = fixture();
    expect((await request(url, "remote-token")).status).toBe(401);
    expect(
      (await request(url.replace(generation, "00000000-0000-4000-8000-000000000002"))).status,
    ).toBe(409);
    expect((await request(url.replace("/workspace/", "/missing/"))).status).toBe(404);
    expect(capture).not.toHaveBeenCalled();
  });
  it("rejects stale revisions and a capture that loses its native admission", async () => {
    const { request, url } = fixture();
    expect((await request(url.replace("revision=4", "revision=3"))).status).toBe(409);
    const other = fixture(
      vi.fn(async () => ({
        status: "captured" as const,
        authority,
        snapshot,
        isCurrent: () => false,
      })),
    );
    expect((await other.request()).status).toBe(409);
  });
  it("bounds concurrent reads and checks workspace rebinding after the await", async () => {
    let resolve!: (value: TerminalReplicaNativeBackingResult) => void;
    const capture = vi.fn(
      () =>
        new Promise<TerminalReplicaNativeBackingResult>((done) => {
          resolve = done;
        }),
    );
    const { request, resolveSession } = fixture(capture);
    const first = request();
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    const second = request();
    resolveSession.mockReturnValue("replacement");
    resolve({ status: "captured", authority, snapshot, isCurrent: () => true });
    expect((await first).status).toBe(409);
    expect((await second).status).toBe(409);
    expect(capture).toHaveBeenCalledTimes(1);
  });
});
