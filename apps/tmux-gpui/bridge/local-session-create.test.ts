import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DAEMON_WIRE_PROTOCOL_VERSION } from "../../../packages/contracts/src/index.ts";
import {
  proveLocalSessionCreate,
  createLocalSession,
  verifyLocalSessionCreateOwner,
} from "./local-session-create.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gpui-first-session-"));
  const path = join(root, "daemon.json");
  const info = {
    pid: process.pid,
    port: 45678,
    protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
    productVersion: "2.9.7",
    instanceId: randomUUID(),
    startedAt: new Date().toISOString(),
    bindHostname: "127.0.0.1",
    authToken: "private-fixture-token",
  };
  await writeFile(path, JSON.stringify(info), { mode: 0o600 });
  let online = false,
    current = true,
    posts = 0;
  let reply: ((receipt: Record<string, unknown>) => Response | Promise<Response>) | undefined;
  const request: typeof fetch = async (url, init) => {
    assert.equal(init?.redirect, "error");
    if (String(url).endsWith("/identity")) {
      assert.equal(init?.headers, undefined);
      return Response.json({ ...info, ok: true });
    }
    assert.equal(
      (init?.headers as Record<string, string>).Authorization,
      `Bearer ${info.authToken}`,
    );
    if (init?.method !== "POST")
      return Response.json({
        version: 1,
        servers: online
          ? [
              {
                serverId: `tmux-server.${"a".repeat(32)}`,
                generation: randomUUID(),
                label: "local",
                state: "online",
              },
            ]
          : [],
      });
    posts++;
    const input = JSON.parse(String(init.body));
    assert.deepEqual(input, {
      displayName: "Example",
      includeLiveSessionId: true,
      expectedDaemonInstanceId: info.instanceId,
    });
    const receipt = {
      operationId: (init.headers as Record<string, string>)["X-Tmux-Ide-Operation-Id"],
      daemonInstanceId: info.instanceId,
      outcome: "created",
      fleetSessionId: `session.${"b".repeat(20)}`,
      workspaceName: "example",
      displayName: "Example",
    };
    return reply ? reply(receipt) : Response.json({ ok: true, result: receipt });
  };
  return {
    path,
    info,
    request,
    context: { current: () => current },
    posts: () => posts,
    online: () => {
      online = true;
    },
    revoke: () => {
      current = false;
    },
    respond: (value: typeof reply) => {
      reply = value;
    },
    close: () => rm(root, { recursive: true, force: true }),
  };
}
async function prove(f: Awaited<ReturnType<typeof fixture>>) {
  const result = await proveLocalSessionCreate({ path: f.path, fetch: f.request, ...f.context });
  assert.equal(result.kind, "available");
  if (result.kind !== "available") throw new Error("Missing proof");
  return result.proof;
}
test("opaque zero-server proof, exact receipt and one-shot duplicate exclusion", async () => {
  const f = await fixture();
  try {
    const proof = await prove(f);
    assert.deepEqual(Object.keys(proof), ["action"]);
    assert.equal(f.posts(), 0);
    const results = await Promise.all([
      createLocalSession(proof, { displayName: "Example" }, f.context),
      createLocalSession(proof, { displayName: "Example" }, f.context),
    ]);
    assert.equal(results[0].kind, "created");
    assert.equal(results[1].kind, "unavailable");
    assert.equal(f.posts(), 1);
  } finally {
    await f.close();
  }
});
test("forged proof, invalid input, online server and changed record cannot mutate", async () => {
  for (const mode of ["forged", "name", "extra", "online", "record", "stale"]) {
    const f = await fixture();
    try {
      const proof = await prove(f);
      if (mode === "online") f.online();
      if (mode === "record")
        await writeFile(f.path, JSON.stringify({ ...f.info, instanceId: randomUUID() }), {
          mode: 0o600,
        });
      if (mode === "stale") f.revoke();
      const result = await createLocalSession(
        mode === "forged" ? { ...proof } : proof,
        mode === "extra"
          ? ({ displayName: "Example", cwd: "/private" } as { displayName: string })
          : { displayName: mode === "name" ? "-invalid" : "Example" },
        f.context,
      );
      assert.notEqual(result.kind, "created");
      assert.equal(f.posts(), 0);
    } finally {
      await f.close();
    }
  }
});
test("online, missing and mismatched identity discovery never mint proof", async () => {
  for (const mode of ["online", "missing", "identity"]) {
    const f = await fixture();
    try {
      if (mode === "online") f.online();
      if (mode === "missing") await rm(f.path);
      const result = await proveLocalSessionCreate({
        path: f.path,
        ...f.context,
        fetch:
          mode === "identity"
            ? async () => Response.json({ ...f.info, instanceId: randomUUID(), ok: true })
            : f.request,
      });
      assert.equal(result.kind, "unavailable");
      assert.equal(f.posts(), 0);
    } finally {
      await f.close();
    }
  }
});
test("uncorrelated, malformed, oversized, failed and redirected receipts are unconfirmed without retry", async () => {
  for (const mode of [
    "operation",
    "daemon",
    "malformed",
    "oversized",
    "failure",
    "redirect",
    "record",
  ]) {
    const f = await fixture();
    try {
      const proof = await prove(f);
      f.respond(async (receipt) => {
        if (mode === "operation") receipt.operationId = randomUUID();
        if (mode === "daemon") receipt.daemonInstanceId = randomUUID();
        if (mode === "record")
          await writeFile(
            f.path,
            JSON.stringify({ ...f.info, startedAt: new Date(0).toISOString() }),
            { mode: 0o600 },
          );
        if (mode === "malformed") return new Response("not JSON");
        if (mode === "oversized") return new Response("x".repeat(256 * 1024 + 1));
        if (mode === "failure") throw new Error("private endpoint secret");
        if (mode === "redirect") return new Response(null, { status: 302 });
        return Response.json({ ok: true, result: receipt });
      });
      assert.deepEqual(await createLocalSession(proof, { displayName: "Example" }, f.context), {
        kind: "unconfirmed",
      });
      assert.equal(f.posts(), 1);
    } finally {
      await f.close();
    }
  }
});
test("abort before effect and during noncooperative body read is bounded and never claims rollback", async () => {
  const f = await fixture();
  try {
    const proof = await prove(f),
      early = new AbortController();
    early.abort();
    assert.deepEqual(
      await createLocalSession(
        proof,
        { displayName: "Example" },
        { ...f.context, signal: early.signal },
      ),
      { kind: "stopped-waiting" },
    );
    assert.equal(f.posts(), 0);
    const next = await prove(f),
      controller = new AbortController();
    let cancelled = false;
    f.respond(() => {
      setTimeout(() => controller.abort(), 10);
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      );
    });
    assert.deepEqual(
      await createLocalSession(
        next,
        { displayName: "Example" },
        { ...f.context, signal: controller.signal },
      ),
      { kind: "stopped-waiting" },
    );
    assert.equal(f.posts(), 1);
    assert.equal(cancelled, true);
  } finally {
    await f.close();
  }
});
test("caller revocation during receipt does not report success", async () => {
  const f = await fixture();
  try {
    const proof = await prove(f);
    f.respond((receipt) => {
      f.revoke();
      return Response.json({ ok: true, result: receipt });
    });
    assert.deepEqual(await createLocalSession(proof, { displayName: "Example" }, f.context), {
      kind: "unconfirmed",
    });
    assert.equal(f.posts(), 1);
  } finally {
    await f.close();
  }
});

test("late noncooperative transport response is discarded and cancelled after abort", async () => {
  const f = await fixture();
  try {
    const proof = await prove(f),
      controller = new AbortController();
    let deliver!: (response: Response) => void;
    let cancelled = false;
    f.respond(
      () =>
        new Promise<Response>((resolve) => {
          deliver = resolve;
          controller.abort();
        }),
    );
    assert.deepEqual(
      await createLocalSession(
        proof,
        { displayName: "Example" },
        {
          ...f.context,
          signal: controller.signal,
        },
      ),
      { kind: "stopped-waiting" },
    );
    deliver(
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(cancelled, true);
    assert.equal(f.posts(), 1);
  } finally {
    await f.close();
  }
});

test("post-create owner fence accepts consumed proof with online servers but rejects replacement", async () => {
  const f = await fixture();
  try {
    const proof = await prove(f);
    assert.equal(
      (await createLocalSession(proof, { displayName: "Example" }, f.context)).kind,
      "created",
    );
    f.online();
    assert.equal(await verifyLocalSessionCreateOwner(proof, f.context), true);
    assert.equal(f.posts(), 1);
    assert.equal(await verifyLocalSessionCreateOwner({ ...proof }, f.context), false);
    const controller = new AbortController();
    controller.abort();
    assert.equal(
      await verifyLocalSessionCreateOwner(proof, { ...f.context, signal: controller.signal }),
      false,
    );
    // A self-consistent replacement record and endpoint must still fail the captured proof.
    f.info.instanceId = randomUUID();
    await writeFile(f.path, JSON.stringify(f.info), { mode: 0o600 });
    assert.equal(await verifyLocalSessionCreateOwner(proof, f.context), false);
    f.revoke();
    assert.equal(await verifyLocalSessionCreateOwner(proof, f.context), false);
    assert.equal(f.posts(), 1);
  } finally {
    await f.close();
  }
});
