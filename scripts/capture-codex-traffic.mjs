#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const fixturesDir = join(root, "packages/daemon/src/codex/__fixtures__");
const prompts = [
  { name: "turn-pong.ndjson", text: "PONG" },
  { name: "turn-2plus2.ndjson", text: "what's 2+2" },
  { name: "turn-ls-tmp.ndjson", text: "list /tmp briefly" },
];

let nextId = 1;
const pending = new Map();
const notifications = new Set();
let child;
let buffer = "";

function fail(message) {
  console.error(`[capture-codex-traffic] ${message}`);
  process.exit(1);
}

function write(payload) {
  child.stdin.write(`${JSON.stringify(payload)}\n`);
}

function request(method, params, timeoutMs = 30_000) {
  const id = nextId++;
  write({ id, method, params });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, method });
  });
}

function notify(method, params) {
  write({ method, params });
}

function isTerminalTurnEvent(frame) {
  if (frame.method === "turn/completed") return true;
  if (frame.method === "item/completed") {
    const item = frame.params?.item;
    const type = item?.type ?? item?.item?.type;
    const phase = item?.phase ?? item?.status ?? item?.item?.phase ?? item?.item?.status;
    return type === "agentMessage" && (phase === "final" || phase === "completed");
  }
  if (frame.method === "rawResponseItem/completed") {
    const item = frame.params?.item;
    const type = item?.type;
    const status = item?.status;
    return type === "message" && status === "completed";
  }
  return false;
}

function handleServerRequest(frame) {
  if (frame.method === "account/chatgptAuthTokens/refresh") {
    write({
      id: frame.id,
      error: { code: -32603, message: "Token refresh is not available in capture script" },
    });
    return;
  }
  if (frame.method === "applyPatchApproval") {
    write({ id: frame.id, result: { decision: "denied" } });
    return;
  }
  write({ id: frame.id, error: { code: -32601, message: `Unhandled request: ${frame.method}` } });
}

function handleFrame(frame) {
  if (frame.id !== undefined && frame.method === undefined) {
    const next = pending.get(frame.id);
    if (!next) return;
    clearTimeout(next.timer);
    pending.delete(frame.id);
    if (frame.error) next.reject(new Error(`${next.method} failed: ${frame.error.message}`));
    else next.resolve(frame.result);
    return;
  }
  if (frame.id !== undefined && typeof frame.method === "string") {
    handleServerRequest(frame);
    return;
  }
  if (typeof frame.method === "string") {
    for (const listener of notifications) listener(frame);
  }
}

function handleChunk(chunk) {
  buffer += chunk.toString("utf8");
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline === -1) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try {
      handleFrame(JSON.parse(line));
    } catch (err) {
      fail(`Invalid JSON from codex: ${err.message}\n${line}`);
    }
  }
}

function captureTurn(prompt) {
  const frames = [];
  let sawTerminal = false;
  let quietTimer;
  let hardTimer;

  return new Promise((resolve, reject) => {
    function finish() {
      clearTimeout(quietTimer);
      clearTimeout(hardTimer);
      notifications.delete(onNotification);
      resolve(frames);
    }
    function onNotification(frame) {
      frames.push(frame);
      if (isTerminalTurnEvent(frame)) sawTerminal = true;
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        if (sawTerminal) finish();
      }, 1_500);
    }

    hardTimer = setTimeout(() => {
      notifications.delete(onNotification);
      reject(new Error(`Timed out capturing turn for ${prompt.name}`));
    }, 120_000);
    notifications.add(onNotification);
  });
}

async function main() {
  child = spawn("codex", ["app-server"], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.on("data", handleChunk);
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  child.on("error", (err) => fail(`Failed to spawn codex app-server: ${err.message}`));

  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("exit", (code, signal) =>
      reject(new Error(`codex exited early: ${code ?? signal}`)),
    );
    child.once("error", reject);
  }).catch((err) => fail(err.message));

  try {
    await request("initialize", {
      clientInfo: { name: "tmux-ide-capture", title: "tmux-ide capture", version: "0.0.1" },
      capabilities: { experimentalApi: true, optOutNotificationMethods: null },
    });
    notify("initialized", {});
    const conversation = await request("thread/start", {
      cwd: root,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      sessionStartSource: "startup",
    });
    const threadId = conversation.thread.id;

    mkdirSync(fixturesDir, { recursive: true });
    for (const prompt of prompts) {
      const captured = captureTurn(prompt);
      await request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt.text }],
        approvalPolicy: "never",
      });
      const frames = await captured;
      writeFileSync(
        join(fixturesDir, prompt.name),
        `${frames.map((f) => JSON.stringify(f)).join("\n")}\n`,
      );
      console.error(`[capture-codex-traffic] wrote ${prompt.name} (${frames.length} frames)`);
    }
  } finally {
    child.kill("SIGTERM");
  }
}

main().catch((err) => fail(err.message));
