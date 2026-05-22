/**
 * pty-bridge ↔ PtyAdapter injection regression test (T087).
 *
 * Asserts that `PtyBridge` consumes the new `PtyAdapter` shape without
 * dropping the runtime semantics the rest of the daemon depends on
 * (replay buffer, exit emission, write/resize plumbing).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PtyBridge } from "../../server/pty-bridge.ts";
import { MockPtyAdapter, MockPtyProcess } from "./MockPtyAdapter.ts";

describe("PtyBridge × MockPtyAdapter", () => {
  let adapter: MockPtyAdapter;
  let bridge: PtyBridge;

  beforeEach(() => {
    adapter = new MockPtyAdapter();
    bridge = new PtyBridge({ ptyAdapter: adapter, coalesceMs: 0 });
  });

  afterEach(() => {
    bridge.dispose();
  });

  it("PtyBridge.spawn() routes through the injected adapter", () => {
    bridge.spawn(80, 24, { cwd: process.cwd() });
    expect(adapter.spawnCount).toBe(1);
    expect(adapter.spawnLog[0]?.cwd).toBe(process.cwd());
    expect(adapter.spawnLog[0]?.cols).toBe(80);
    expect(adapter.spawnLog[0]?.rows).toBe(24);
  });

  it("data from the mock process surfaces as 'output' events on the bridge", () => {
    bridge.spawn(80, 24, { cwd: process.cwd() });
    const received: Buffer[] = [];
    bridge.on("output", (chunk: Buffer) => received.push(chunk));
    const proc = adapter.lastSpawned() as MockPtyProcess;
    proc.pushOutput("hello pty\n");
    expect(Buffer.concat(received).toString()).toBe("hello pty\n");
  });

  it("mock-emitted exit surfaces as 'exit' on the bridge with the right code/signal", () => {
    bridge.spawn(80, 24, { cwd: process.cwd() });
    const exits: Array<{ code: number; signal: number | null }> = [];
    bridge.on("exit", (evt: { code: number; signal: number | null }) => exits.push(evt));
    (adapter.lastSpawned() as MockPtyProcess).emitExit({ exitCode: 42, signal: 9 });
    expect(exits).toEqual([{ code: 42, signal: 9 }]);
    expect(bridge.running).toBe(false);
  });

  it("PtyBridge.write() forwards to the adapter's write log", () => {
    bridge.spawn(80, 24, { cwd: process.cwd() });
    bridge.write("ls -la\n");
    const proc = adapter.lastSpawned() as MockPtyProcess;
    expect(proc.writeLog.at(-1)).toBe("ls -la\n");
  });

  it("PtyBridge.resize() forwards to the adapter and updates cols/rows", () => {
    bridge.spawn(80, 24, { cwd: process.cwd() });
    bridge.resize(120, 30);
    expect(bridge.cols).toBe(120);
    expect(bridge.rows).toBe(30);
    const proc = adapter.lastSpawned() as MockPtyProcess;
    expect(proc.resizeLog).toEqual([{ cols: 120, rows: 30 }]);
  });

  it("PtyBridge.kill() propagates a signal to the adapter's process", () => {
    bridge.spawn(80, 24, { cwd: process.cwd() });
    const proc = adapter.lastSpawned() as MockPtyProcess;
    bridge.kill("SIGTERM");
    expect(proc.killed).toBe("SIGTERM");
  });

  it("replay buffer captures output across multiple flushes", () => {
    bridge.spawn(80, 24, { cwd: process.cwd() });
    const proc = adapter.lastSpawned() as MockPtyProcess;
    proc.pushOutput("aaa");
    proc.pushOutput("bbb");
    expect(bridge.getReplayBuffer().toString()).toBe("aaabbb");
  });

  it("restartWith() reuses the adapter and spawns a fresh process", () => {
    bridge.spawn(80, 24, { cwd: process.cwd() });
    const first = adapter.lastSpawned();
    bridge.restartWith(100, 30, { cwd: process.cwd() });
    expect(adapter.spawnCount).toBe(2);
    const second = adapter.lastSpawned();
    expect(second).not.toBe(first);
    expect(adapter.spawnLog[1]?.cols).toBe(100);
  });

  it("legacy `options.pty.spawn` injection still wraps a NodePtyAdapter", () => {
    // Hand-rolled stub matching the pre-T087 contract — the bridge should
    // wrap it without complaint.
    const handData: Array<(data: unknown) => void> = [];
    const handExit: Array<(evt: { exitCode: number; signal?: number | null }) => void> = [];
    const stub = {
      spawn() {
        return {
          pid: 4242,
          onData(cb: (data: unknown) => void) {
            handData.push(cb);
            return { dispose: () => undefined };
          },
          onExit(cb: (evt: { exitCode: number; signal?: number | null }) => void) {
            handExit.push(cb);
            return { dispose: () => undefined };
          },
          write() {},
          resize() {},
          kill() {},
        };
      },
    };
    const legacyBridge = new PtyBridge({
      pty: { spawn: stub.spawn as unknown as never },
      coalesceMs: 0,
    });
    expect(() => legacyBridge.spawn(80, 24, { cwd: process.cwd() })).not.toThrow();
    expect(legacyBridge.running).toBe(true);
    legacyBridge.dispose();
  });

  it("spawn-then-mock-exit clears `bridge.running`", () => {
    bridge.spawn(80, 24, { cwd: process.cwd() });
    expect(bridge.running).toBe(true);
    (adapter.lastSpawned() as MockPtyProcess).emitExit({ exitCode: 0, signal: null });
    expect(bridge.running).toBe(false);
  });
});
