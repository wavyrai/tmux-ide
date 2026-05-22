import { describe, expect, it } from "bun:test";
import { PassThrough } from "node:stream";

import { CodexAgentExitedError, CodexRpcError } from "./errors.ts";
import { makeJsonRpcEndpoint } from "./protocol.ts";

function readLine(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    stream.once("data", (chunk) => resolve(String(chunk)));
  });
}

function writeJson(stream: PassThrough, payload: unknown): void {
  stream.write(`${JSON.stringify(payload)}\n`);
}

function expectRejectsWith<T extends Error>(
  promise: Promise<unknown>,
  constructor: new (...args: never[]) => T,
): Promise<T> {
  return promise.then(
    () => {
      throw new Error("Expected promise to reject");
    },
    (err) => {
      expect(err).toBeInstanceOf(constructor);
      return err as T;
    },
  );
}

describe("Codex protocol", () => {
  it("round-trips request/response and omits the jsonrpc field", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const endpoint = makeJsonRpcEndpoint({ input, output });

    const pending = endpoint.request("initialize", { clientInfo: { name: "test", version: "0" } });
    expect(JSON.parse(await readLine(output))).toEqual({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "test", version: "0" } },
    });

    writeJson(input, { id: 1, result: { userAgent: "mock" } });
    expect(await pending).toEqual({ userAgent: "mock" });
  });

  it("ignores a mismatched response id until the matching response arrives", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const endpoint = makeJsonRpcEndpoint({ input, output });

    const pending = endpoint.request("initialize");
    await readLine(output);
    writeJson(input, { id: 999, result: "wrong" });
    writeJson(input, { id: 1, result: "right" });

    expect(await pending).toBe("right");
  });

  it("surfaces server error responses as CodexRpcError", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const endpoint = makeJsonRpcEndpoint({ input, output });

    const pending = endpoint.request("initialize");
    await readLine(output);
    writeJson(input, { id: 1, error: { code: -32000, message: "boom", data: { detail: true } } });

    const err = await expectRejectsWith(pending, CodexRpcError);
    expect(err.code).toBe(-32000);
    expect(err.data).toEqual({ detail: true });
  });

  it("dispatches notifications", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const endpoint = makeJsonRpcEndpoint({ input, output });
    const received = new Promise<unknown>((resolve) => endpoint.onNotification(resolve));

    writeJson(input, { method: "item/agentMessage/delta", params: { delta: "hi" } });

    expect(await received).toEqual({
      method: "item/agentMessage/delta",
      params: { delta: "hi" },
    });
  });

  it("rejects pending requests when the stream closes", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const endpoint = makeJsonRpcEndpoint({ input, output });

    const pending = endpoint.request("initialize");
    await readLine(output);
    input.end();

    await expectRejectsWith(pending, CodexAgentExitedError);
  });
});
