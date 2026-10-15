import process from "node:process";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, stat, mkdtemp, writeFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { stopFixtureChild } from "./fixture-child.mjs";
import { DAEMON_WIRE_PROTOCOL_VERSION } from "../../../packages/contracts/src/index.ts";

// Validate explicit package selection before allocating any fixture resources.
// A supplied package never falls back to source or loads tsx in its child.
const packagedApp = process.env.TMUX_GPUI_TEST_APP;
if (packagedApp !== undefined) {
  assert.ok(isAbsolute(packagedApp), "TMUX_GPUI_TEST_APP must be a nonempty absolute path");
  assert.ok((await stat(packagedApp)).isDirectory(), "TMUX_GPUI_TEST_APP must be a directory");
  for (const file of ["node", "bridge/browser.bundle.mjs"]) {
    const path = join(packagedApp, "Contents/Resources", file);
    assert.ok((await stat(path)).isFile(), "Packaged helper must be a regular file");
    await access(path, file === "node" ? constants.X_OK : constants.R_OK);
  }
}
const browserNode =
  packagedApp === undefined ? process.execPath : join(packagedApp, "Contents/Resources/node");
const browserArgs =
  packagedApp === undefined
    ? ["--import", import.meta.resolve("tsx"), resolve("apps/tmux-gpui/bridge/browser.ts")]
    : [join(packagedApp, "Contents/Resources/bridge/browser.bundle.mjs")];

// Actual --local browser and fleet owner; private HTTP/discovery files only.
// No daemon bootstrap, SSH, tmux server, or terminal subscription is needed.
for (const mode of ["retired", "inflight", "active-failure"])
  test(
    mode === "active-failure"
      ? "Active fleet verification failures remain errors rather than retired-route guidance"
      : `Refresh of a ${mode} selected fleet route reports route guidance without fallback`,
    async () => {
      const root = await mkdtemp("/tmp/gpui-fleet-refresh-");
      const scope = { serverId: `tmux-server.${"a".repeat(32)}`, generation: randomUUID() };
      const identity = {
        pid: process.pid,
        instanceId: randomUUID(),
        startedAt: new Date().toISOString(),
        protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
        productVersion: "fixture",
        environmentId: randomUUID(),
      };
      const token = randomUUID();
      let child,
        latest,
        fatal,
        buffer = "",
        stderr = "";
      const failures = [];
      let routeRemoved = false;
      let routeRetirementObserved = false;
      let unavailablePublications = 0;
      let holdIdentity = false,
        heldIdentity,
        failIdentity = false;
      const server = createServer((req, res) => {
        res.setHeader("content-type", "application/json");
        if (req.url === "/identity") {
          if (failIdentity) {
            res.end("{}");
            return;
          }
          if (holdIdentity) {
            heldIdentity = res;
            return;
          }
          res.end(JSON.stringify({ ...identity, ok: true }));
        } else if (req.headers.authorization !== `Bearer ${token}`) {
          res.statusCode = 401;
          res.end("{}");
        } else if (req.url === "/api/v1/tmux-servers")
          res.end(
            JSON.stringify({
              version: 1,
              servers: [{ ...scope, label: "Owned server", state: "online" }],
            }),
          );
        else if (req.url.endsWith("/sessions"))
          res.end(JSON.stringify({ version: 1, server: scope, sessions: [] }));
        else {
          res.statusCode = 404;
          res.end("{}");
        }
      });
      const until = async (predicate) => {
        const deadline = Date.now() + 15000;
        for (;;) {
          if (fatal) throw fatal;
          if (predicate()) return;
          assert.ok(
            !child || (child.exitCode === null && child.signalCode === null),
            "browser exited",
          );
          assert.ok(Date.now() < deadline, "fleet publication deadline");
          await delay(10);
        }
      };
      const send = (value) => child.stdin.write(JSON.stringify(value) + "\n");
      try {
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const record = join(root, "daemon.json");
        await writeFile(
          record,
          JSON.stringify({
            ...identity,
            port: server.address().port,
            bindHostname: "127.0.0.1",
            authToken: token,
          }),
          { mode: 0o600 },
        );
        const env = Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) =>
              !key.startsWith("TMUX") &&
              ![
                "NODE_OPTIONS",
                "NODE_PATH",
                "HOME",
                "TMPDIR",
                "XDG_CONFIG_HOME",
                "XDG_STATE_HOME",
                "XDG_CACHE_HOME",
              ].includes(key),
          ),
        );
        Object.assign(env, {
          HOME: root,
          TMUX_IDE_HOME: root,
          TMPDIR: root,
          XDG_CONFIG_HOME: root,
          XDG_STATE_HOME: root,
          XDG_CACHE_HOME: root,
        });
        if (packagedApp !== undefined) env.PATH = "/usr/bin:/bin";
        child = spawn(browserNode, [...browserArgs, "--local"], {
          cwd: root,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
        child.on("error", (error) => {
          fatal ??= error;
        });
        child.stdin.on("error", (error) => {
          fatal ??= error;
        });
        child.stderr.on("data", (chunk) => {
          if (fatal) return;
          if (Buffer.byteLength(stderr) + chunk.length > 65536) {
            fatal = new Error("stderr limit");
            return;
          }
          stderr += chunk;
        });
        child.stdout.on("data", (chunk) => {
          if (fatal) return;
          try {
            buffer += chunk;
            assert.ok(Buffer.byteLength(buffer) <= 8 * 1024 * 1024);
            let end;
            while ((end = buffer.indexOf("\n")) >= 0) {
              latest = JSON.parse(buffer.slice(0, end));
              if (routeRemoved && latest.home.phase === "unavailable") {
                // Every intermediate retirement/failure publication must stay safe,
                // even before the requested refresh has produced its final guidance.
                unavailablePublications++;
                if (latest.status === "Machine connection changed — refresh sessions to reconnect")
                  routeRetirementObserved = true;
                assert.equal(latest.snapshot, null);
                assert.equal(latest.inputReady, false);
                assert.equal(latest.selectedServer, null);
                assert.deepEqual(latest.sessions, []);
              }
              buffer = buffer.slice(end + 1);
            }
          } catch (error) {
            fatal ??= error;
          }
        });
        send({ type: "presence", active: true, revision: 1 });
        await until(
          () =>
            latest?.presenceRevision === 1 &&
            latest.fleet?.groups.some((g) => g.servers?.some((s) => s.selection)),
        );
        const connection = latest.connection;
        const group = latest.fleet.groups.find((g) =>
          g.servers.some((s) => s.id === scope.serverId),
        );
        const selected = group.servers.find((s) => s.id === scope.serverId);
        send({ type: "fleet-server", request: 1, selection: selected.selection });
        await until(
          () =>
            latest?.request === 1 &&
            latest.home.phase === "live" &&
            latest.selectedServer?.serverId === scope.serverId,
        );
        if (mode === "active-failure") {
          failIdentity = true;
          send({ type: "refresh", request: 2 });
          await until(
            () =>
              latest?.request === 2 &&
              latest.home.phase === "unavailable" &&
              latest.status === "Connection unavailable — start the daemon and refresh" &&
              stderr.length > 0,
          );
          assert.equal(stderr, "Could not read private native-browser host configuration\n");
          assert.equal(latest.snapshot, null);
          assert.equal(latest.inputReady, false);
        } else {
          // Retire the selected route while its exact host verification is in flight.
          if (mode === "inflight") {
            holdIdentity = true;
            send({ type: "refresh", request: 2 });
            await until(() => heldIdentity !== undefined);
          }
          routeRemoved = true;
          await rm(record);
          // Home can become unavailable before the selected route is retired.
          // Wait for the actual retirement, not just its first visible symptom.
          // Latch the decoded event: an aborted inflight refresh may immediately
          // publish its failure guidance in the same stdout chunk.
          await until(() => routeRetirementObserved);
          holdIdentity = false;
          heldIdentity?.end(JSON.stringify({ ...identity, ok: true }));
          for (const request of [3, 4]) {
            send({ type: "refresh", request });
            await until(
              () =>
                latest?.request === request &&
                latest.home.phase === "unavailable" &&
                latest.status ===
                  "Machine or session changed. Refresh the fleet and select the session again.",
            );
            assert.equal(stderr, "", "retired route must not be misclassified as private config");
            assert.equal(
              latest.status,
              "Machine or session changed. Refresh the fleet and select the session again.",
            );
            assert.equal(latest.connection, connection);
            assert.equal(latest.snapshot, null);
            assert.equal(latest.inputReady, false);
            assert.equal(latest.selectedServer, null);
            assert.deepEqual(latest.sessions, []);
          }
          assert.ok(unavailablePublications > 0, "retirement publications were checked");
          assert.equal(stderr, "", "retired route must not be misclassified as private config");
        }
      } catch (error) {
        failures.push(error);
      } finally {
        for (const cleanup of [
          () => stopFixtureChild(child),
          async () => {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
          },
          () => rm(root, { recursive: true, force: true }),
        ]) {
          try {
            await cleanup();
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (fatal && !failures.includes(fatal)) failures.push(fatal);
      if (failures.length)
        throw new AggregateError(failures, "Fleet Refresh diagnostic regression");
    },
  );
