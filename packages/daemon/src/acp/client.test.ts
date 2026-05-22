import { describe, expect, test } from "bun:test";

import { AcpAgentExitedError, AcpAgentSpawnError, spawnAcpClient } from "./index.ts";

const echoAgent = String.raw`
const readline = require("node:readline");
let pendingPrompt = null;
function send(payload) { process.stdout.write(JSON.stringify(payload) + "\n"); }
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentInfo: { name: "fake", version: "1" } } });
    return;
  }
  if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s1" } });
    return;
  }
  if (msg.method === "session/load") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }
  if (msg.method === "session/prompt") {
    const text = msg.params?.prompt?.[0]?.text;
    if (text === "permission") {
      pendingPrompt = msg.id;
      send({
        jsonrpc: "2.0",
        id: "perm-1",
        method: "session/request_permission",
        params: {
          sessionId: "s1",
          toolCall: { toolCallId: "tool-1", title: "Edit file" },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }]
        }
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } } }
    });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn", userMessageId: msg.params?.messageId ?? null } });
    return;
  }
  if (msg.id === "perm-1") {
    send({ jsonrpc: "2.0", id: pendingPrompt, result: { stopReason: "end_turn", permission: msg.result } });
    return;
  }
});
`;

const crashAgent = String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "session/prompt") process.exit(7);
});
`;

function customClient(script: string) {
  return spawnAcpClient({
    provider: { kind: "custom", command: process.execPath, args: ["-e", script] },
  });
}

describe("spawnAcpClient", () => {
  test("spawns a custom ACP agent and initializes", async () => {
    const client = await customClient(echoAgent);
    await expect(client.initialize()).resolves.toMatchObject({ protocolVersion: 1 });
    await client.close();
  });

  test("round-trips newSession, loadSession, and prompt", async () => {
    const client = await customClient(echoAgent);

    await expect(client.newSession({ cwd: process.cwd(), mcpServers: [] })).resolves.toEqual({
      sessionId: "s1",
    });
    await expect(
      client.loadSession({ cwd: process.cwd(), mcpServers: [], sessionId: "s1" }),
    ).resolves.toEqual({});
    await expect(
      client.prompt({
        sessionId: "s1",
        messageId: "m1",
        prompt: [{ type: "text", text: "hello" }],
      }),
    ).resolves.toEqual({ stopReason: "end_turn", userMessageId: "m1" });
    await client.close();
  });

  test("surfaces session/update notifications", async () => {
    const client = await customClient(echoAgent);
    const updates: unknown[] = [];
    client.onSessionUpdate((notification) => updates.push(notification));

    await client.prompt({ sessionId: "s1", prompt: [{ type: "text", text: "hello" }] });

    expect(updates).toEqual([
      {
        sessionId: "s1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } },
      },
    ]);
    await client.close();
  });

  test("responds to session/request_permission using registered handler", async () => {
    const client = await customClient(echoAgent);
    const requests: unknown[] = [];
    client.onPermissionRequest(async (request) => {
      requests.push(request);
      return { outcome: { outcome: "selected", optionId: "allow" } };
    });

    await expect(
      client.prompt({ sessionId: "s1", prompt: [{ type: "text", text: "permission" }] }),
    ).resolves.toMatchObject({
      stopReason: "end_turn",
      permission: { outcome: { outcome: "selected", optionId: "allow" } },
    });
    expect(requests).toHaveLength(1);
    await client.close();
  });

  test("close SIGTERMs the child and closed resolves", async () => {
    const client = await customClient(echoAgent);
    await client.close();
    await expect(client.closed).resolves.toMatchObject({ signal: "SIGTERM" });
  });

  test("agent crash rejects an in-flight prompt", async () => {
    const client = await customClient(crashAgent);
    const prompt = client.prompt({ sessionId: "s1", prompt: [{ type: "text", text: "boom" }] });
    await expect(prompt).rejects.toBeInstanceOf(AcpAgentExitedError);
    await client.closed;
  });

  test("missing claude-code binary throws AcpAgentSpawnError", async () => {
    await expect(
      spawnAcpClient({ provider: { kind: "claude-code", binary: "/nope/missing" } }),
    ).rejects.toBeInstanceOf(AcpAgentSpawnError);
  });
});
