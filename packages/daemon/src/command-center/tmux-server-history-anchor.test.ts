import { expect, it, vi } from "vitest";
import { Hono } from "hono";
import { HistoryAnchorIdentitySchemaZ, type HistoryAnchorRequest } from "@tmux-ide/contracts";
import { blankTerminalReplicaSnapshot } from "@tmux-ide/core";
import { TmuxServerOwners } from "../lib/tmux-server-owners.ts";
import type { NativeTmuxServerOwner } from "../lib/tmux-server-owner.ts";
import { HistoryAnchorOwner } from "../terminal/session-runtime/history-anchor-owner.ts";
import { mountTmuxServerRoutes } from "./tmux-servers.ts";
async function fixture() {
  const tracker = new HistoryAnchorOwner();
  const dispatch = vi.fn((session: string, input: HistoryAnchorRequest) => {
    expect(session).toBe("actual");
    return input.operation.kind === "capture"
      ? tracker.capture(
          {
            ...input.proof,
            revision: "revision" in input.proof ? input.proof.revision : -1,
            stateHash: "stateHash" in input.proof ? input.proof.stateHash : "",
          },
          input.operation.historyIndex,
        )
      : tracker.resolve(input.proof, input.operation.token);
  });
  const catalog = vi.fn(async () => [
    { sessionName: "actual", liveSessionId: `live-session.${"a".repeat(20)}` },
  ]);
  const owners = new TmuxServerOwners<NativeTmuxServerOwner>({
    probe: async (selector) => ({
      fingerprint: JSON.stringify(selector),
      authority: { executablePath: "/fixture/tmux", socketSelector: selector },
      valid: () => true,
    }),
    create: async () =>
      ({
        catalog,
        workspaceRegistry: {
          get: (name: string) => (name === "alias" ? { sessionName: "actual" } : null),
        },
        sessionRuntimeRegistry: { historyAnchor: dispatch },
        dispose: async () => tracker.invalidate(),
      }) as unknown as NativeTmuxServerOwner,
  });
  const server = await owners.register({
    label: "fixture",
    selector: { kind: "name", name: "fixture" },
  });
  const generation = server.generation!;
  const snapshot = blankTerminalReplicaSnapshot(4, 2);
  const proof = {
    workspaceName: "alias",
    semanticPaneId: "pane-a",
    generation,
    incarnation: "i",
    revision: 0,
    stateHash: "0000000000000000",
  };
  const seed = {
    ...proof,
    workspaceName: "actual",
    type: "terminal.seed" as const,
    cols: 4,
    rows: 2,
    hashAlgorithm: "fnv1a64-v1" as const,
    snapshot: { ...snapshot, history: [snapshot.grid[0]!, snapshot.grid[0]!] },
  };
  tracker.observe(seed);
  const app = new Hono();
  mountTmuxServerRoutes(app, { owners, ownerToken: "owner" });
  const path = `/api/v1/tmux-servers/${server.serverId}/${generation}/history-anchor`;
  const body = {
    version: 1,
    liveSessionId: `live-session.${"a".repeat(20)}`,
    proof,
    operation: { kind: "capture", historyIndex: 1 },
  };
  const request = (value: unknown = body, auth = "owner", signal?: AbortSignal) =>
    app.request(path, {
      method: "POST",
      headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify(value),
      signal,
    });
  return { owners, tracker, dispatch, catalog, seed, proof, body, request };
}
it("authenticates and restores alias-scoped anchors without terminal owner creation", async () => {
  const f = await fixture();
  expect((await f.request(undefined, "wrong")).status).toBe(401);
  expect(f.dispatch).not.toHaveBeenCalled();
  const capture = await (await f.request()).json();
  expect(capture.result.status).toBe("captured");
  const identity = HistoryAnchorIdentitySchemaZ.parse({
    workspaceName: f.proof.workspaceName,
    semanticPaneId: f.proof.semanticPaneId,
    generation: f.proof.generation,
    incarnation: f.proof.incarnation,
  });
  const response = await f.request({
    ...f.body,
    proof: identity,
    operation: { kind: "resolve", token: capture.result.token },
  });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect((await response.json()).result).toEqual({
    status: "resolved",
    proof: f.proof,
    historyIndex: 1,
  });
  await f.owners.dispose();
});
it("refuses wrong pane, wrong live identity, malformed proof and reset token", async () => {
  const f = await fixture();
  expect(
    (await (await f.request({ ...f.body, proof: { ...f.proof, semanticPaneId: "wrong" } })).json())
      .result.status,
  ).toBe("stale");
  expect(
    (await (await f.request({ ...f.body, liveSessionId: `live-session.${"b".repeat(20)}` })).json())
      .result.status,
  ).toBe("stale");
  expect((await f.request({ ...f.body, proof: { ...f.proof, stateHash: "secret" } })).status).toBe(
    400,
  );
  expect(
    (await (await f.request({ ...f.body, proof: { ...f.proof, revision: 100 } })).json()).result
      .status,
  ).toBe("stale");
  const capture = await (await f.request()).json();
  f.tracker.observe(f.seed);
  const identity = HistoryAnchorIdentitySchemaZ.parse({
    workspaceName: f.proof.workspaceName,
    semanticPaneId: f.proof.semanticPaneId,
    generation: f.proof.generation,
    incarnation: f.proof.incarnation,
  });
  expect(
    (
      await (
        await f.request({
          ...f.body,
          proof: identity,
          operation: { kind: "resolve", token: capture.result.token },
        })
      ).json()
    ).result.status,
  ).toBe("lost");
  await f.owners.dispose();
  expect((await f.request()).status).toBe(409);
});
it("bounds payload and aborts before catalog or after pending catalog", async () => {
  const f = await fixture();
  expect((await f.request({ ...f.body, extra: "x".repeat(5000) })).status).toBe(400);
  const abort = new AbortController();
  abort.abort();
  expect((await f.request(f.body, "owner", abort.signal)).status).toBe(503);
  expect(f.catalog).not.toHaveBeenCalled();
  let ready!: () => void, release!: (value: Awaited<ReturnType<typeof f.catalog>>) => void;
  const entered = new Promise<void>((r) => (ready = r));
  f.catalog.mockImplementation(() => {
    ready();
    return new Promise((r) => (release = r));
  });
  const next = new AbortController();
  const pending = f.request(f.body, "owner", next.signal);
  await entered;
  next.abort();
  release([]);
  expect((await pending).status).toBe(503);
  expect(f.dispatch).not.toHaveBeenCalled();
  await f.owners.dispose();
});
