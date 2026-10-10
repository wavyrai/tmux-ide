// Boundary peer test: a real browser helper, private record, and loopback HTTP peer.
// This is not a historical daemon executable qualification.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import { DAEMON_WIRE_PROTOCOL_VERSION } from "../../../packages/contracts/src/index.ts";

const packagedApp = process.env.TMUX_GPUI_TEST_APP;
for (const packaged of [false, true])
  test(
    `${packaged ? "packaged" : "source"} unsupported daemon stays credential-free and refresh rechecks compatibility`,
    {
      timeout: 15000,
      skip:
        packaged && !packagedApp
          ? "Set TMUX_GPUI_TEST_APP to qualify the exact packaged helper"
          : false,
    },
    async () => {
      if (packaged) assert.ok(isAbsolute(packagedApp), "Packaged app must be absolute");
      const dir = await mkdtemp(join(tmpdir(), "gpui-compatibility-"));
      let protocolVersion = DAEMON_WIRE_PROTOCOL_VERSION + 1;
      const token = "test-only-" + randomUUID();
      const identity = {
        pid: process.pid,
        instanceId: randomUUID(),
        startedAt: new Date().toISOString(),
        productVersion: "test-peer",
      };
      const requests = [];
      const server = createServer((req, res) => {
        requests.push({ path: req.url, authorized: !!req.headers.authorization });
        res.setHeader("Content-Type", "application/json");
        if (req.url === "/identity")
          res.end(JSON.stringify({ ...identity, ok: true, protocolVersion }));
        else {
          res.statusCode = 500;
          res.end("{}");
        }
      });
      let browser, closed, fatal;
      const publications = [];
      let stderr = "",
        buffer = "";
      const wait = async (predicate) => {
        const end = Date.now() + 4000;
        while (true) {
          if (fatal) throw fatal;
          if (predicate()) return;
          assert.ok(
            browser.exitCode === null && browser.signalCode === null,
            "browser closed unexpectedly",
          );
          assert.ok(Date.now() < end, "browser publication deadline");
          await new Promise((done) => setTimeout(done, 10));
        }
      };
      try {
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const record = () =>
          writeFile(
            join(dir, "daemon.json"),
            JSON.stringify({
              ...identity,
              protocolVersion,
              port: server.address().port,
              bindHostname: "127.0.0.1",
              authToken: token,
            }),
            { mode: 0o600 },
          );
        await record();
        const env = Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) =>
              !key.startsWith("TMUX_IDE_") && !["NODE_OPTIONS", "NODE_PATH", "TMUX"].includes(key),
          ),
        );
        Object.assign(env, {
          HOME: dir,
          TMUX_IDE_HOME: dir,
          TMUX_IDE_DAEMON_INFO_DIR: dir,
          TMUX_IDE_REGISTRY_DIR: dir,
        });
        browser = spawn(
          packaged ? join(packagedApp, "Contents/Resources/node") : process.execPath,
          packaged
            ? [join(packagedApp, "Contents/Resources/bridge/browser.bundle.mjs"), "--local"]
            : [
                "--import",
                import.meta.resolve("tsx"),
                resolve("apps/tmux-gpui/bridge/browser.ts"),
                "--local",
              ],
          { env, cwd: dir, stdio: ["pipe", "pipe", "pipe"] },
        );
        closed = once(browser, "close").catch((error) => {
          fatal ??= error;
        });
        browser.stdin.on("error", (error) => {
          fatal ??= error;
        });
        browser.stderr.on("data", (chunk) => {
          stderr = (stderr + chunk).slice(-16000);
        });
        browser.stdout.on("data", (chunk) => {
          if (fatal) return;
          try {
            buffer += chunk;
            assert.ok(buffer.length <= 8 * 1024 * 1024, "Bounded helper publication");
            let end;
            while ((end = buffer.indexOf("\n")) >= 0) {
              assert.ok(publications.length < 128, "Bounded fixture publication count");
              publications.push(JSON.parse(buffer.slice(0, end)));
              buffer = buffer.slice(end + 1);
            }
          } catch (error) {
            fatal ??= error;
          }
        });
        await wait(() => publications.length > 0);
        assert.match(publications.at(-1).status, /incompatible/i);
        assert.equal(publications.at(-1).inputReady, false);
        assert.equal(publications.at(-1).snapshot, null);
        assert.ok(requests.every((req) => req.path === "/identity" && !req.authorized));
        const connection = publications.at(-1).connection;
        protocolVersion = DAEMON_WIRE_PROTOCOL_VERSION - 1;
        await record();
        browser.stdin.write(JSON.stringify({ type: "refresh", request: 1 }) + "\n");
        await wait(
          () =>
            publications.at(-1)?.request === 1 && /incompatible/i.test(publications.at(-1).status),
        );
        assert.equal(publications.at(-1).connection, connection);
        assert.equal(publications.at(-1).inputReady, false);
        assert.equal(publications.at(-1).snapshot, null);
        assert.ok(requests.every((req) => req.path === "/identity" && !req.authorized));
        // Correcting the explicit fixture record/peer permits discovery to advance to
        // authenticated catalog access. The synthetic peer intentionally returns 500.
        protocolVersion = DAEMON_WIRE_PROTOCOL_VERSION;
        await record();
        browser.stdin.write(JSON.stringify({ type: "refresh", request: 2 }) + "\n");
        await wait(() => requests.some((req) => req.authorized));
        await wait(
          () =>
            publications.at(-1)?.request === 2 && /unavailable/i.test(publications.at(-1).status),
        );
        assert.equal(publications.at(-1).connection, connection);
        assert.equal(publications.at(-1).inputReady, false);
        assert.ok(!JSON.stringify(publications).includes(token));
        assert.ok(!stderr.includes(token));
      } finally {
        try {
          if (browser) {
            browser.stdin.end();
            const timer = setTimeout(() => browser.kill("SIGKILL"), 1500);
            try {
              await closed;
            } finally {
              clearTimeout(timer);
            }
          }
        } finally {
          try {
            server.closeAllConnections();
            await new Promise((done) => server.close(done));
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        }
      }
      if (fatal) throw fatal;
    },
  );
