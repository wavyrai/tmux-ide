import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createPreviewCatalog } from "./catalog.ts";
import { CatalogStageError } from "./catalog-errors.ts";

const secret = "PRIVATE_TOKEN_AND_RESPONSE";
const scope = {
  serverId: `tmux-server.${"a".repeat(32)}`,
  generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};
const session = `live-session.${"a".repeat(20)}`;
async function fixture(
  replies: readonly { status?: number; body: unknown }[],
  run: (catalog: ReturnType<typeof createPreviewCatalog>) => Promise<void>,
) {
  let calls = 0;
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    const reply = replies[calls++];
    res.writeHead(reply?.status ?? 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(reply?.body ?? { secret }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const catalog = createPreviewCatalog({
    baseUrl: `http://127.0.0.1:${address.port}`,
    ownerToken: secret,
    scope,
  });
  try {
    await run(catalog);
    assert.equal(calls, replies.length, "no retries or extra requests");
  } finally {
    catalog.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}
const sessions = {
  body: {
    version: 1,
    server: scope,
    sessions: [
      { liveSessionId: session, sessionName: secret, workspaceName: secret, paneCount: 1 },
    ],
  },
};
const inventory = (count = 1) => ({
  body: {
    version: 1,
    server: scope,
    resource: {
      workspaceName: secret,
      workspaceId: "workspace.0123456789abcdefabcd",
      sessionId: "session.0123456789abcdefabcd",
      resourceRevision: 0,
      semanticPaneIds: Array.from({ length: count }, (_, i) => `pane.p${i}`).sort(),
    },
  },
});
function failure(stage: string, extra?: string) {
  return (error: unknown) => {
    assert.ok(error instanceof CatalogStageError);
    assert.ok(error.message.includes(stage), error.message);
    if (extra) assert.ok(error.message.includes(extra), error.message);
    assert.ok(!String(error.stack).includes(secret));
    assert.ok(!JSON.stringify(error).includes(secret));
    assert.equal(error.cause, undefined);
    assert.ok(Buffer.byteLength(error.message, "utf8") <= 256);
    return true;
  };
}

test("workspace refresh identifies each HTTP boundary without retries or private errors", async () => {
  const denied = { status: 503, body: { error: secret } };
  for (const [prefix, stage] of [
    [[], "list sessions"],
    [[sessions], "read pane inventory"],
    [[sessions, inventory()], "revalidate session"],
  ] as const) {
    await fixture([...prefix, denied], async (c) =>
      assert.rejects(c.workspacePanes(session, secret), failure(stage, "HTTP 503")),
    );
  }
});
test("workspace refresh distinguishes absent identity before and after inventory", async () => {
  const absent = { body: { ...sessions.body, sessions: [] } };
  for (const [replies, stage] of [
    [[absent], "list sessions"],
    [[sessions, inventory(), absent], "revalidate session"],
  ] as const) {
    await fixture(replies, async (c) =>
      assert.rejects(c.workspacePanes(session, secret), failure(stage, "selection unavailable")),
    );
  }
});
test("workspace refresh distinguishes invalid inventory and connection projection", async () => {
  await fixture([sessions, { body: { secret } }], async (c) =>
    assert.rejects(c.workspacePanes(session, secret), failure("read pane inventory")),
  );
  await fixture([sessions, inventory(25), sessions], async (c) =>
    assert.rejects(
      c.workspacePanes(session, secret),
      failure("validate pane connection", "invalid response"),
    ),
  );
});
test("workspace refresh still returns successful inventory in the same request order", async () => {
  await fixture([sessions, inventory(), sessions], async (c) =>
    assert.equal((await c.workspacePanes(session, secret))[0]?.semanticPaneId, "pane.p0"),
  );
});

test("workspace inventory scope rejection is distinct from schema and HTTP failure", async () => {
  const mismatch = inventory();
  mismatch.body.server = { ...scope, generation: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
  await fixture([sessions, mismatch], async (c) => {
    await assert.rejects(c.workspacePanes(session, secret), (error) => {
      assert.ok(error instanceof CatalogStageError);
      assert.deepEqual(error.diagnostic, { stage: "inventory", reason: "scope mismatch" });
      return failure("read pane inventory", "scope mismatch")(error);
    });
  });
});
