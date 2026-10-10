import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import process from "node:process";
import { Buffer } from "node:buffer";
import { runBrowserTraceFixture, traceMetadata } from "./browser-trace-fixture.mjs";

test("trace forwards exact fragmented bytes and records only navigation metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "gpui-trace-"));
  try {
    const input = new PassThrough(),
      output = new PassThrough();
    const chunks = [];
    output.on("data", (v) => chunks.push(v));
    const publication =
      JSON.stringify({
        sequence: 1,
        request: 2,
        sessionCatalogComplete: true,
        preferredPane: "pane-a",
        selectedSession: "session-a",
        panes: [{ id: "pane-a", windowId: "w" }],
        connection: { ownerToken: "SECRET" },
        snapshot: { cells: ["PRIVATE TERMINAL"] },
      }) + "\n";
    const command = '{"type":"input","input":{"data":"SECRET KEYSTROKES"}}\n';
    const code = `let input='';process.stdin.on('data',v=>input+=v);process.stdin.on('end',()=>{if(input!==${JSON.stringify(command)})process.exitCode=2;else process.stdout.write(${JSON.stringify(publication)})});`;
    const pending = runBrowserTraceFixture({
      executable: process.execPath,
      args: ["-e", code],
      tracePath: join(root, "trace"),
      input,
      output,
    });
    input.write(command.slice(0, 7));
    input.end(command.slice(7));
    assert.equal(await pending, 0);
    assert.equal(Buffer.concat(chunks).toString(), publication);
    const trace = readFileSync(join(root, "trace"), "utf8");
    assert.doesNotMatch(trace, /SECRET|PRIVATE|pane-a|session-a/);
    assert.equal(JSON.parse(trace.trim().split("\n")[1]).preferredMember, true);
    assert.equal(statSync(join(root, "trace")).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("aborted fixture reaps its exact child without forwarding private input data", async () => {
  const root = mkdtempSync(join(tmpdir(), "gpui-trace-"));
  try {
    const controller = new globalThis.AbortController();
    const pending = runBrowserTraceFixture({
      executable: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      tracePath: join(root, "trace"),
      input: new PassThrough(),
      output: new PassThrough(),
      signal: controller.signal,
    });
    controller.abort();
    assert.equal(await pending, 0);
    assert.deepEqual(
      traceMetadata("command", {
        type: "presence",
        active: false,
        revision: 3,
        ownerToken: "SECRET",
      }),
      { direction: "command", type: "presence", request: null, active: false, revision: 3 },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "bounded retirement handles an EOF-ignoring child and an unconsumed output",
  { timeout: 10000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "gpui-trace-"));
    try {
      const input = new PassThrough();
      const pending = runBrowserTraceFixture({
        executable: process.execPath,
        args: ["-e", "process.stdin.resume();setInterval(()=>{},1000)"],
        tracePath: join(root, "eof"),
        input,
        output: new PassThrough(),
      });
      input.end();
      assert.equal(await pending, 1);
      const controller = new globalThis.AbortController();
      const abortOnWrite = new Writable({
        highWaterMark: 1,
        write() {
          controller.abort();
        },
      });
      const outputRun = runBrowserTraceFixture({
        executable: process.execPath,
        args: [
          "-e",
          'process.stdout.write(JSON.stringify({snapshot:{cells:"x".repeat(100000)}})+"\\n");setInterval(()=>{},1000)',
        ],
        tracePath: join(root, "blocked"),
        input: new PassThrough(),
        output: abortOnWrite,
        signal: controller.signal,
      });
      assert.equal(await outputRun, 0);
      abortOnWrite.destroy();
      assert.equal(
        await runBrowserTraceFixture({
          executable: join(root, "missing"),
          args: [],
          tracePath: join(root, "spawn"),
          input: new PassThrough(),
          output: new PassThrough(),
        }),
        1,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
