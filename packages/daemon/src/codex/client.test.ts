import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexAgentSpawnError } from "./errors.ts";
import { CLIENT_METHODS } from "./methods.ts";
import { spawnCodexClient, type CodexClient } from "./client.ts";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function makeMockBinary(): string {
  const dir = mkdtempSync(join(tmpdir(), "tmux-ide-codex-peer-"));
  tempDirs.push(dir);
  const script = join(dir, "mock-codex-peer.js");
  writeFileSync(
    script,
    `#!/usr/bin/env node
let buffer = "";
let pendingThreadStartId = null;
let pendingApprovalId = null;
let nextServerRequestId = 1000;

function write(payload) {
  process.stdout.write(JSON.stringify(payload) + "\\n");
}

function respond(id, result) {
  write({ id, result });
}

function threadStartResponse() {
  return {
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    cwd: process.cwd(),
    model: "gpt-5.2",
    modelProvider: "openai",
    sandbox: { mode: "workspace-write" },
    thread: { id: "thread-1" }
  };
}

function turnStartResponse() {
  return { turn: { id: "turn-1", status: "inProgress" } };
}

function handleMethod(message) {
  switch (message.method) {
    case "initialize":
      respond(message.id, {
        userAgent: "mock-codex-app-server",
        codexHome: process.cwd(),
        platformFamily: process.platform === "win32" ? "windows" : "unix",
        platformOs: process.platform === "darwin" ? "macos" : process.platform
      });
      return;
    case "thread/start":
      if (message.params && message.params.cwd === "/needs-approval") {
        pendingThreadStartId = message.id;
        pendingApprovalId = nextServerRequestId++;
        write({
          id: pendingApprovalId,
          method: "applyPatchApproval",
          params: {
            callId: "call-1",
            conversationId: "thread-1",
            fileChanges: {
              "/tmp/app.ts": { type: "add", content: "hello" }
            },
            reason: "Need write access"
          }
        });
        return;
      }
      respond(message.id, threadStartResponse());
      return;
    case "turn/start":
      write({
        method: "item/agentMessage/delta",
        params: {
          delta: "Mock server is ready.",
          itemId: "item-1",
          threadId: "thread-1",
          turnId: "turn-1"
        }
      });
      respond(message.id, turnStartResponse());
      return;
    case "turn/interrupt":
      respond(message.id, {});
      return;
    default:
      if (message.id !== undefined) {
        write({ id: message.id, error: { code: -32601, message: "Unhandled request: " + message.method } });
      }
  }
}

function handleResponse(message) {
  if (message.id !== pendingApprovalId) return;
  pendingApprovalId = null;
  respond(pendingThreadStartId, threadStartResponse());
  pendingThreadStartId = null;
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const message = JSON.parse(trimmed);
    if ("method" in message) handleMethod(message);
    else if ("id" in message) handleResponse(message);
  }
});
process.stdin.on("end", () => process.exit(0));
`,
  );
  chmodSync(script, 0o755);
  return script;
}

async function makeClient(): Promise<CodexClient> {
  return await spawnCodexClient({ provider: { kind: "codex", binary: makeMockBinary() } });
}

describe("Codex client", () => {
  it("spawns a custom binary and initializes", async () => {
    const client = await makeClient();
    try {
      expect(await client.initialize()).toMatchObject({
        userAgent: "mock-codex-app-server",
        platformFamily: expect.any(String),
      });
    } finally {
      await client.close();
    }
  });

  it("round-trips newConversation", async () => {
    const client = await makeClient();
    try {
      const response = await client.newConversation({ cwd: "/tmp/project" });
      expect(response.thread.id).toBe("thread-1");
      expect(response.approvalsReviewer).toBe("user");
    } finally {
      await client.close();
    }
  });

  it("emits agentMessage events", async () => {
    const client = await makeClient();
    const eventPromise = new Promise((resolve) => client.onAgentEvent(resolve));
    try {
      await client.sendUserMessage({
        threadId: "thread-1",
        input: [{ type: "text", text: "hello" }],
      });
      expect(await eventPromise).toEqual({
        method: CLIENT_METHODS.item_agent_message_delta,
        params: {
          delta: "Mock server is ready.",
          itemId: "item-1",
          threadId: "thread-1",
          turnId: "turn-1",
        },
      });
    } finally {
      await client.close();
    }
  });

  it("handles server-to-client applyPatchApproval requests", async () => {
    const client = await makeClient();
    const approvalPromise = new Promise((resolve) => {
      client.onApplyPatchApproval(async (request) => {
        resolve(request);
        return { decision: "approved" };
      });
    });
    try {
      const response = await client.newConversation({ cwd: "/needs-approval" });
      expect(response.thread.id).toBe("thread-1");
      expect(await approvalPromise).toMatchObject({
        callId: "call-1",
        conversationId: "thread-1",
      });
    } finally {
      await client.close();
    }
  });

  it("interrupts and closes the child", async () => {
    const client = await makeClient();
    await client.interrupt({ threadId: "thread-1", turnId: "turn-1" });
    await client.close();

    const closed = await client.closed;
    expect(closed.signal === "SIGTERM" || closed.code === 0 || closed.code === null).toBe(true);
  });

  it("throws CodexAgentSpawnError for a missing binary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tmux-ide-codex-missing-"));
    tempDirs.push(dir);
    const missing = join(dir, "missing-codex");
    await expect(
      spawnCodexClient({ provider: { kind: "codex", binary: missing } }),
    ).rejects.toBeInstanceOf(CodexAgentSpawnError);
  });
});
