import { PassThrough } from "node:stream";
import { describe, expect, test } from "bun:test";

import { AcpAgentExitedError, AcpRpcError } from "./errors.ts";
import { makeJsonRpcEndpoint } from "./protocol.ts";

function makeHarness() {
  const input = new PassThrough();
  const output = new PassThrough();
  const endpoint = makeJsonRpcEndpoint({ input, output });
  const writes: unknown[] = [];
  output.on("data", (chunk) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.trim()) writes.push(JSON.parse(line));
    }
  });
  return { endpoint, input, output, writes };
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("makeJsonRpcEndpoint", () => {
  test("resolves requests with matching responses", async () => {
    const { endpoint, input, writes } = makeHarness();
    const promise = endpoint.request("initialize", { hello: true });
    await tick();
    expect(writes[0]).toMatchObject({ jsonrpc: "2.0", id: 1, method: "initialize" });

    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } })}\n`);
    await expect(promise).resolves.toEqual({ ok: true });
    await endpoint.close();
  });

  test("leaves requests pending for mismatched ids", async () => {
    const { endpoint, input } = makeHarness();
    let settled = false;
    const promise = endpoint.request("initialize").finally(() => {
      settled = true;
    });

    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 999, result: { ok: true } })}\n`);
    await tick();
    expect(settled).toBe(false);

    await endpoint.close(new AcpAgentExitedError("done"));
    await expect(promise).rejects.toBeInstanceOf(AcpAgentExitedError);
  });

  test("rejects requests with server-side errors", async () => {
    const { endpoint, input } = makeHarness();
    const promise = endpoint.request("session/prompt");
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32602, message: "bad params", data: { field: "prompt" } },
      })}\n`,
    );

    await expect(promise).rejects.toBeInstanceOf(AcpRpcError);
    await promise.catch((err) => {
      expect(err.code).toBe(-32602);
      expect(err.data).toEqual({ field: "prompt" });
    });
    await endpoint.close();
  });

  test("routes notifications without writing a response", async () => {
    const { endpoint, input, writes } = makeHarness();
    const seen: unknown[] = [];
    endpoint.onNotification((notification) => seen.push(notification));

    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { n: 1 } })}\n`,
    );
    await tick();

    expect(seen).toEqual([{ jsonrpc: "2.0", method: "session/update", params: { n: 1 } }]);
    expect(writes).toEqual([]);
    await endpoint.close();
  });

  test("rejects pending requests when the stream closes", async () => {
    const { endpoint, input } = makeHarness();
    const promise = endpoint.request("initialize");
    input.end();

    await expect(promise).rejects.toBeInstanceOf(AcpAgentExitedError);
    await endpoint.closed;
  });

  test("parses frames split across chunk boundaries", async () => {
    const { endpoint, input } = makeHarness();
    const promise = endpoint.request("initialize");
    input.write('{"jsonrpc":"2.0",');
    input.write('"id":1,"result":{"split":true}}\n');

    await expect(promise).resolves.toEqual({ split: true });
    await endpoint.close();
  });

  test("responds to incoming requests with handler results", async () => {
    const { endpoint, input, writes } = makeHarness();
    endpoint.onIncomingRequest(async (request) => ({ method: request.method }));

    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: "r1", method: "client/ask" })}\n`);
    await tick();

    expect(writes[0]).toEqual({ jsonrpc: "2.0", id: "r1", result: { method: "client/ask" } });
    await endpoint.close();
  });

  test("preserves explicit RPC errors from incoming request handlers", async () => {
    const { endpoint, input, writes } = makeHarness();
    endpoint.onIncomingRequest(async () => {
      throw new AcpRpcError({
        code: -32601,
        message: "Method not found",
        data: { method: "client/nope" },
      });
    });

    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: "r1", method: "client/nope" })}\n`);
    await tick();

    expect(writes[0]).toEqual({
      jsonrpc: "2.0",
      id: "r1",
      error: { code: -32601, message: "Method not found", data: { method: "client/nope" } },
    });
    await endpoint.close();
  });
});
