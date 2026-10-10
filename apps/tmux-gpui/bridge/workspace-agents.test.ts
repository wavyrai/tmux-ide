import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createPreviewCatalog } from "./catalog.ts";
import { openWorkspaceAgentSchema } from "./home-agent-publication.ts";
const scope = {
  serverId: "tmux-server." + "a".repeat(32),
  generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};
const liveId = "live-session." + "a".repeat(20);
test("workspace navigation uses only read requests and rechecks exact session after inventory", async () => {
  for (const mismatch of ["none", "before", "after", "workspace"]) {
    const paths: string[] = [];
    const server = createServer((req, res) => {
      paths.push(req.url!);
      assert.equal(req.method, "GET");
      assert.equal(req.headers.authorization, "Bearer owner");
      const inventory = req.url!.includes("/inventory/");
      const changed = mismatch === "before" || (mismatch === "after" && paths.length === 3);
      const body = inventory
        ? {
            version: 1,
            server: scope,
            resource: {
              workspaceName: "workspace",
              workspaceId: "workspace.0123456789abcdefabcd",
              sessionId: "session.0123456789abcdefabcd",
              resourceRevision: 0,
              semanticPaneIds: ["pane.a", "pane.b"],
            },
          }
        : {
            version: 1,
            server: scope,
            sessions: [
              {
                liveSessionId: changed ? "live-session." + "b".repeat(20) : liveId,
                sessionName: "same-name",
                workspaceName: mismatch === "workspace" ? "other" : "workspace",
                paneCount: 2,
              },
            ],
          };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const catalog = createPreviewCatalog({
      baseUrl: `http://127.0.0.1:${address.port}`,
      ownerToken: "owner",
      scope,
    });
    try {
      if (mismatch === "none") {
        const panes = await catalog.workspacePanes(liveId, "workspace");
        assert.deepEqual(
          panes.map((p) => p.semanticPaneId),
          ["pane.a", "pane.b"],
        );
        assert.ok(panes.every((p) => p.liveSessionId === liveId));
      } else await assert.rejects(catalog.workspacePanes(liveId, "workspace"));
      assert.equal(
        paths.some((path) => path.includes("/open")),
        false,
      );
      assert.equal(paths.length, mismatch === "before" || mismatch === "workspace" ? 1 : 3);
    } finally {
      catalog.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});
test("workspace click requires selected session in addition to request and roster revision", () => {
  const command = {
    type: "open-workspace-agent",
    request: 2,
    fromRequest: 1,
    rosterRevision: 1,
    key: "exact-key",
    sessionId: liveId,
  };
  assert.deepEqual(openWorkspaceAgentSchema.parse(command), command);
  for (const value of [
    { ...command, sessionId: "" },
    { ...command, fromRequest: -1 },
    { ...command, rosterRevision: 0 },
    { ...command, extra: true },
  ])
    assert.equal(openWorkspaceAgentSchema.safeParse(value).success, false);
});
