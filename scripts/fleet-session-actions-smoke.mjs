#!/usr/bin/env node
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const repo = fileURLToPath(new URL("../", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "fleet-actions-smoke-"));
const state = join(directory, "state");
mkdirSync(state);
const socket = `fleet-actions-${process.pid}-${Date.now()}`;
const tmux = execFileSync("/bin/sh", ["-c", "command -v tmux"], { encoding: "utf8" }).trim();
const env = {
  ...process.env,
  TMUX: "",
  TMUX_IDE_HOME: directory,
  TMUX_IDE_DAEMON_INFO_DIR: state,
  TMUX_IDE_REGISTRY_DIR: state,
  TMUX_IDE_TMUX_SOCKET_NAME: socket,
  TMUX_IDE_TMUX_BIN: tmux,
};
delete env.TMUX_IDE_TMUX_SOCKET_PATH;
const runTmux = (...args) =>
  execFileSync(tmux, ["-L", socket, ...args], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
let daemon;
try {
  runTmux("-f", "/dev/null", "new-session", "-d", "-s", "fixture-keeper", "sleep 120");
  runTmux("new-session", "-d", "-s", "ordinary-close-fixture", "sleep 120");
  execFileSync(process.execPath, [join(repo, "bin/cli.js"), "update", "--daemon", "--json"], {
    env,
    encoding: "utf8",
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemon = JSON.parse(readFileSync(join(state, "daemon.json"), "utf8"));
  const base = `http://127.0.0.1:${daemon.port}`;
  const headers = {
    Authorization: `Bearer ${daemon.authToken}`,
    "Content-Type": "application/json",
  };
  const catalog = async () => {
    const response = await fetch(`${base}/api/resources/workspace-catalog?version=3`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    assert(response.ok, "Catalog request failed");
    return response.json();
  };
  const action = async (name, input, operationId = randomUUID()) => {
    const response = await fetch(`${base}/api/v2/action/${name}`, {
      method: "POST",
      headers: {
        ...headers,
        "X-Tmux-Ide-Operation-Id": operationId,
        ...(name === "workspace.session.create"
          ? { "X-Tmux-Ide-Host-Client-Id": "fleet-actions-smoke" }
          : {}),
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.json();
    return {
      status: response.status,
      ok: body.ok === true,
      result: body.result,
      code: body.error?.code,
      message: body.error?.message,
    };
  };
  const requireOk = (result, step) =>
    assert(
      result.ok,
      `${step} refused (HTTP ${result.status}, ${result.code ?? "unknown"}: ${result.message ?? "no detail"})`,
    );
  const before = await catalog();
  const original = before.liveSessions.find(
    (session) => session.sessionName === "ordinary-close-fixture",
  );
  assert(original, "Unregistered fixture not discovered");
  const closeInput = (session) => ({
    workspaceName: session.sessionName,
    fleetTarget: {
      daemonInstanceId: daemon.instanceId,
      liveSessionId: session.liveSessionId,
      sessionName: session.sessionName,
    },
  });
  runTmux("kill-session", "-t", "=ordinary-close-fixture");
  runTmux("new-session", "-d", "-s", "ordinary-close-fixture", "sleep 120");
  const stale = await action("workspace.session.kill", closeInput(original));
  assert(!stale.ok, "A stale session close unexpectedly succeeded");
  runTmux("has-session", "-t", "=ordinary-close-fixture");
  const replacement = (await catalog()).liveSessions.find(
    (session) => session.sessionName === "ordinary-close-fixture",
  );
  assert(
    replacement && replacement.liveSessionId !== original.liveSessionId,
    "Replacement identity not distinct",
  );
  const wrongDaemonInput = closeInput(replacement);
  wrongDaemonInput.fleetTarget.daemonInstanceId = randomUUID();
  const wrongDaemon = await action("workspace.session.kill", wrongDaemonInput);
  assert(!wrongDaemon.ok, "Wrong daemon close unexpectedly succeeded");
  runTmux("has-session", "-t", "=ordinary-close-fixture");
  const close = await action("workspace.session.kill", closeInput(replacement));
  requireOk(close, "Unregistered exact close");
  assert(
    !(await catalog()).liveSessions.some(
      (session) => session.sessionName === "ordinary-close-fixture",
    ),
    "Closed fixture remains live",
  );
  const createOperation = randomUUID();
  const createInput = {
    displayName: "fleet-create-fixture",
    cwd: directory,
    expectedDaemonInstanceId: daemon.instanceId,
  };
  const created = await action("workspace.session.create", createInput, createOperation);
  requireOk(created, "Create");
  const replay = await action("workspace.session.create", createInput, createOperation);
  requireOk(replay, "Create replay");
  assert.equal(
    replay.result.fleetSessionId,
    created.result.fleetSessionId,
    "Create replay changed identity",
  );
  const createdSession = (await catalog()).liveSessions.find(
    (session) => session.sessionName !== "fixture-keeper",
  );
  assert(createdSession, "Created session missing");
  requireOk(
    await action("workspace.session.kill", closeInput(createdSession)),
    "Created session close",
  );
  runTmux("has-session", "-t", "=fixture-keeper");
  console.log(
    JSON.stringify(
      {
        passed: true,
        isolatedSocket: true,
        ordinarySessionClose: true,
        staleIncarnationRejected: true,
        replacementPreserved: true,
        wrongDaemonRejected: true,
        ownerCreate: true,
        createIdempotency: true,
        createdSessionClose: true,
      },
      null,
      2,
    ),
  );
} finally {
  if (daemon) {
    try {
      process.kill(daemon.pid, "SIGTERM");
    } catch {
      // The isolated daemon may already have exited.
    }
  }
  try {
    runTmux("kill-server");
  } catch {
    // The isolated tmux server may already have exited.
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  rmSync(directory, { recursive: true, force: true });
}
