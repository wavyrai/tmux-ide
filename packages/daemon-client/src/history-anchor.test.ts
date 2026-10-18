import { expect, it } from "bun:test";
import { requestHistoryAnchor } from "./tmux-server-client.ts";
import type { HistoryAnchorRequest } from "@tmux-ide/contracts";
const scope = {
  serverId: `tmux-server.${"a".repeat(32)}`,
  generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};
const proof = {
  workspaceName: "alias",
  semanticPaneId: "pane-a",
  generation: scope.generation,
  incarnation: "i",
  revision: 1,
  stateHash: "0000000000000001",
};
const body: HistoryAnchorRequest = {
  version: 1,
  liveSessionId: `live-session.${"a".repeat(20)}`,
  proof,
  operation: { kind: "capture", historyIndex: 0 },
};
const options = {
  baseUrl: "http://localhost",
  ownerToken: "private",
  hostClientId: "test",
  origin: "http://localhost",
};
it("unsupported old route returns null once, no retry", async () => {
  let calls = 0;
  expect(
    await requestHistoryAnchor(
      {
        ...options,
        fetch: async () => {
          calls++;
          return new Response("", { status: 404 });
        },
      },
      scope,
      body,
    ),
  ).toBeNull();
  expect(calls).toBe(1);
});
it("resolve permits newer revision but checks all immutable identity", async () => {
  const identity = {
    workspaceName: proof.workspaceName,
    semanticPaneId: proof.semanticPaneId,
    generation: proof.generation,
    incarnation: proof.incarnation,
  };
  const request: HistoryAnchorRequest = {
    ...body,
    proof: identity,
    operation: { kind: "resolve", token: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
  };
  const result = {
    status: "resolved",
    proof: { ...proof, revision: 9, stateHash: "0000000000000009" },
    historyIndex: 2,
  };
  expect(
    (
      await requestHistoryAnchor(
        { ...options, fetch: async () => Response.json({ version: 1, server: scope, result }) },
        scope,
        request,
      )
    )?.result,
  ).toEqual(result);
  await expect(
    requestHistoryAnchor(
      {
        ...options,
        fetch: async () =>
          Response.json({
            version: 1,
            server: scope,
            result: { ...result, proof: { ...result.proof, incarnation: "new" } },
          }),
      },
      scope,
      request,
    ),
  ).rejects.toThrow();
});
it("rejects oversized response and mismatched operation result", async () => {
  await expect(
    requestHistoryAnchor(
      { ...options, fetch: async () => new Response("x".repeat(4097)) },
      scope,
      body,
    ),
  ).rejects.toThrow();
  await expect(
    requestHistoryAnchor(
      {
        ...options,
        fetch: async () =>
          Response.json({
            version: 1,
            server: scope,
            result: { status: "resolved", proof, historyIndex: 0 },
          }),
      },
      scope,
      body,
    ),
  ).rejects.toThrow();
});
