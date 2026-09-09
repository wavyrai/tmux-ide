import type { TerminalNativeBackingResponse } from "../../terminal/session-runtime/native-seed-backing.ts";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { mountTerminalNativeBackingRoute } from "./terminal-native-backing-route.ts";
import {
  decodeNativeGridCapture,
  encodeNativeGridCapture,
} from "../../terminal/mirror/native-grid-capture.ts";
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
  capture = vi.fn<() => Promise<TerminalNativeBackingResponse>>(async () => ({
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

it("does not coalesce requests for different retained revisions", async () => {
  let done!: (value: TerminalReplicaNativeBackingResult) => void;
  const capture = vi.fn(
    () =>
      new Promise<TerminalReplicaNativeBackingResult>((resolve) => {
        done = resolve;
      }),
  );
  const { request, url } = fixture(capture);
  const a = request();
  await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
  const firstDone = done;
  const b = request(url.replace("revision=4", "revision=3"));
  await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(2));
  firstDone({ status: "captured", authority, snapshot, isCurrent: () => true });
  done({
    status: "captured",
    authority: { ...authority, revision: 3 },
    snapshot,
    isCurrent: () => true,
  });
  expect((await a).status).toBe(200);
  expect((await b).status).toBe(200);
  expect(capture.mock.calls[0]).toEqual([
    "session",
    "pane",
    { generation, incarnation: authority.incarnation, revision: 4, stateHash: "hash" },
  ]);
});

it("serves retained bytes directly without exposing the retained payload", async () => {
  const encoded = new TextEncoder().encode(encodeNativeGridCapture(snapshot)!);
  const capture = vi.fn(
    async (): Promise<TerminalNativeBackingResponse> => ({
      status: "retained",
      authority,
      isCurrent: () => true,
      encodeBody: (prefix) => {
        const body = new Uint8Array(prefix.length + encoded.length);
        body.set(prefix);
        body.set(encoded, prefix.length);
        return body;
      },
    }),
  );
  const { request } = fixture(capture);
  const first = await request();
  expect(first.status).toBe(200);
  const bytes = new Uint8Array(await first.arrayBuffer());
  bytes.fill(0);
  const body = await (await request()).text();
  expect(JSON.parse(body.slice(0, body.indexOf("\n")))).toEqual({
    ...authority,
    workspaceName: "workspace",
  });
  expect(decodeNativeGridCapture(body.slice(body.indexOf("\n") + 1))).toEqual(snapshot);
});
