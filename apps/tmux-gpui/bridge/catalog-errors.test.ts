import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createPreviewCatalog } from "./catalog.ts";
import { CatalogStageError } from "./catalog-errors.ts";
import { TmuxServerClientError } from "../../../packages/daemon-client/src/tmux-server-client.ts";

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
const opened = {
  body: { version: 1, server: scope, workspaceName: secret, liveSessionId: session },
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
test("actual client identifies each HTTP failure stage without leaking response or credentials", async () => {
  const denied = { status: 503, body: { error: secret } };
  await fixture([denied], async (c) =>
    assert.rejects(c.sessions(), failure("list sessions", "HTTP 503")),
  );
  for (const [prefix, stage] of [
    [[], "revalidate session"],
    [[sessions], "open session"],
    [[sessions, opened], "read pane inventory"],
  ] as const) {
    await fixture([...prefix, denied], async (c) =>
      assert.rejects(c.panes(session), failure(stage, "HTTP 503")),
    );
  }
});
test("schema, stale selection and scope failures are distinct and sanitized", async () => {
  await fixture([{ body: { secret } }], async (c) =>
    assert.rejects(c.panes(session), failure("revalidate session", "invalid response")),
  );
  await fixture([{ body: { ...sessions.body, sessions: [] } }], async (c) =>
    assert.rejects(c.panes(session), failure("selection unavailable")),
  );
  await fixture(
    [
      sessions,
      {
        body: {
          ...opened.body,
          server: { ...scope, generation: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
        },
      },
    ],
    async (c) => assert.rejects(c.panes(session), failure("open session", "scope mismatch")),
  );
  await fixture([sessions, opened, inventory(25)], async (c) =>
    assert.rejects(c.panes(session), failure("validate pane connection", "invalid response")),
  );
});
test("successful catalog returns the same exact scoped pane configuration", async () => {
  await fixture([sessions, opened, inventory()], async (c) => {
    const [pane] = await c.panes(session);
    assert.equal(pane.ownerToken, secret);
    assert.equal(pane.workspaceName, secret);
    assert.equal(pane.liveSessionId, session);
    assert.deepEqual(pane.scope, scope);
    assert.deepEqual(pane.visiblePaneIds, ["pane.p0"]);
    assert.equal(pane.semanticPaneId, "pane.p0");
  });
});
test("untrusted messages/names and invalid HTTP status cannot enter public diagnostics", () => {
  for (const error of [
    new Error(secret),
    Object.assign(new Error(secret), { name: secret }),
    new TypeError(secret),
    new SyntaxError(secret),
  ]) {
    failure("read pane inventory")(new CatalogStageError("inventory", error));
  }
  for (const status of [NaN, Infinity, 99, 600, 401.5]) {
    const error = new CatalogStageError(
      "inventory",
      new TmuxServerClientError("request-failed", status),
    );
    assert.ok(!error.message.includes("HTTP"));
  }
  assert.ok(
    new CatalogStageError("inventory", new DOMException(secret, "TimeoutError")).message.includes(
      "timed out",
    ),
  );
});
