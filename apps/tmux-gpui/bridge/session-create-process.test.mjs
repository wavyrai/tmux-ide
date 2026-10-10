// Real browser process with an owned HTTP peer; no personal daemon or session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test(
  "browser creates from initial Home once, keeps navigation responsive and requires refresh after uncertain failure",
  { timeout: 20000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "gpui-create-"));
    const scope = {
      serverId: `tmux-server.${"a".repeat(32)}`,
      generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    };
    const secret = "PRIVATE_RESPONSE_TOKEN";
    let list = [],
      creates = [],
      held,
      failList = false;
    const server = createServer(async (req, res) => {
      assert.equal(req.headers.authorization, `Bearer ${secret}`);
      res.setHeader("Content-Type", "application/json");
      if (req.url.endsWith("/sessions/create")) {
        let body = "";
        for await (const chunk of req) body += chunk;
        const payload = JSON.parse(body);
        creates.push(payload);
        held = { res, payload };
        return;
      }
      if (failList) {
        res.statusCode = 503;
        res.end(JSON.stringify({ secret }));
        return;
      }
      res.end(JSON.stringify({ version: 1, server: scope, sessions: list }));
    });
    let child,
      closed,
      buffer = "",
      stderr = "";
    const events = [];
    const until = async (check) => {
      const deadline = Date.now() + 5000;
      while (!check()) {
        assert.ok(Date.now() < deadline, "publication deadline");
        assert.equal(child.exitCode, null, stderr);
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    const send = (value) => child.stdin.write(JSON.stringify(value) + "\n");
    const finish = (success = true) => {
      assert.ok(held);
      const { res, payload } = held;
      held = undefined;
      if (!success) {
        res.statusCode = 503;
        res.end(JSON.stringify({ secret }));
        return;
      }
      res.end(
        JSON.stringify({
          operationId: payload.operationId,
          daemonInstanceId: scope.generation,
          outcome: "created",
          fleetSessionId: "session.0123456789abcdefabcd",
          workspaceName: "created",
          displayName: payload.intent.displayName,
        }),
      );
    };
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const host = join(root, "host.json");
      await writeFile(
        host,
        JSON.stringify({
          baseUrl: `http://127.0.0.1:${server.address().port}`,
          ownerToken: secret,
          scope,
        }),
        { mode: 0o600 },
      );
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([k]) => !k.startsWith("TMUX") && !["NODE_OPTIONS", "NODE_PATH"].includes(k),
        ),
      );
      Object.assign(env, { HOME: root, TMUX_IDE_HOME: root });
      child = spawn(
        process.execPath,
        ["--import", "tsx", resolve("apps/tmux-gpui/bridge/browser.ts"), host],
        { env, stdio: ["pipe", "pipe", "pipe"] },
      );
      closed = once(child, "close");
      child.stderr.on("data", (c) => {
        stderr = (stderr + c).slice(-16000);
      });
      child.stdout.on("data", (c) => {
        buffer += c;
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          events.push(JSON.parse(buffer.slice(0, end)));
          buffer = buffer.slice(end + 1);
        }
      });
      await until(() => events.at(-1)?.home.phase === "live");
      assert.equal(events.at(-1).request, 0);
      send({ type: "presence", active: true, revision: 1 });
      await until(() => events.at(-1).presenceRevision === 1);
      assert.equal(events.at(-1).inputReady, false);
      assert.equal(events.at(-1).snapshot, null);
      send({ type: "create-session", request: 0, name: "  First  " });
      await until(() => creates.length === 1 && events.at(-1).createSession.phase === "pending");
      send({ type: "create-session", request: 0, name: "Duplicate" });
      send({ type: "appearance", system: "light" });
      const count = events.length;
      await until(() => events.length > count);
      assert.equal(creates.length, 1);
      assert.equal(creates[0].intent.displayName, "First");
      assert.equal(creates[0].expectedDaemonInstanceId, scope.generation);
      list = [
        {
          liveSessionId: `live-session.${"b".repeat(20)}`,
          sessionName: "First",
          workspaceName: "created",
          paneCount: 3,
        },
      ];
      finish();
      await until(
        () => events.at(-1).createSession.phase === "idle" && events.at(-1).sessions.length === 1,
      );
      assert.equal(events.at(-1).surface, "home");
      assert.equal(events.at(-1).snapshot, null);
      assert.equal(events.at(-1).selectedSession, null);
      assert.equal(events.at(-1).sessions[0].paneCount, 3);
      send({ type: "create-session", request: 0, name: "Late" });
      await until(() => creates.length === 2);
      list = list.map((item) => ({ ...item, paneCount: 5 }));
      send({ type: "refresh", request: 1 });
      await until(() => events.at(-1).request === 1 && events.at(-1).home.phase === "live");
      assert.equal(events.at(-1).sessions[0].paneCount, 5);
      list = [];
      finish();
      await until(() => events.at(-1).createSession.phase === "idle");
      assert.equal(
        events.at(-1).sessions.length,
        1,
        "stale create cannot refresh a replacement catalog",
      );
      send({ type: "create-session", request: 1, name: "Failure" });
      await until(() => creates.length === 3);
      send({ type: "presence", active: false, revision: 2 });
      finish(false);
      await until(() => events.at(-1).createSession.phase === "failed");
      send({ type: "presence", active: true, revision: 3 });
      send({ type: "create-session", request: 1, name: "No retry" });
      send({ type: "appearance", system: "dark" });
      const failedCount = events.length;
      await until(() => events.length > failedCount);
      assert.equal(creates.length, 3);
      send({ type: "refresh", request: 2 });
      await until(
        () => events.at(-1).request === 2 && events.at(-1).createSession.phase === "idle",
      );
      send({ type: "create-session", request: 2, name: "Refresh failure" });
      await until(() => creates.length === 4);
      failList = true;
      finish();
      await until(() => events.at(-1).createSession.phase === "failed");
      assert.equal(events.at(-1).surface, "home");
      assert.equal(events.at(-1).snapshot, null);
      assert.ok(!JSON.stringify(events).includes(secret));
      assert.ok(!stderr.includes(secret));
    } finally {
      if (held) {
        held.res.destroy();
        held = undefined;
      }
      if (child) {
        child.stdin.end();
        const timer = setTimeout(() => child.kill("SIGKILL"), 1500);
        try {
          await closed;
        } finally {
          clearTimeout(timer);
        }
      }
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await rm(root, { recursive: true, force: true });
    }
  },
);
