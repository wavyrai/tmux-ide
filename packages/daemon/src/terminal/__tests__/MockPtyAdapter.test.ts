/**
 * MockPtyAdapter unit tests (T087).
 *
 * Distinct from the contract suite — these assert mock-specific affordances
 * (writeLog, pushOutput, emitExit, failNext, syncUnsupported) the contract
 * tests deliberately don't cover.
 */

import { describe, expect, it, vi } from "vitest";
import { PtySpawnError } from "../PtyAdapter.ts";
import { MockPtyAdapter, MockPtyProcess } from "./MockPtyAdapter.ts";

const baseInput = {
  shell: "/bin/zsh",
  cwd: "/tmp",
  cols: 80,
  rows: 24,
  env: { PATH: "/usr/bin" } as NodeJS.ProcessEnv,
};

describe("MockPtyAdapter", () => {
  it("auto-increments pids across spawns", async () => {
    const adapter = new MockPtyAdapter({ startingPid: 1000 });
    const a = await adapter.spawn(baseInput);
    const b = await adapter.spawn(baseInput);
    expect(a.pid).toBe(1000);
    expect(b.pid).toBe(1001);
  });

  it("records every spawn input in spawnLog", async () => {
    const adapter = new MockPtyAdapter();
    await adapter.spawn({ ...baseInput, shell: "/bin/bash" });
    await adapter.spawn({ ...baseInput, shell: "/bin/zsh" });
    expect(adapter.spawnCount).toBe(2);
    expect(adapter.spawnLog.map((s) => s.shell)).toEqual(["/bin/bash", "/bin/zsh"]);
  });

  it("pushOutput delivers bytes to onData subscribers", async () => {
    const adapter = new MockPtyAdapter();
    const proc = (await adapter.spawn(baseInput)) as MockPtyProcess;
    const received: Buffer[] = [];
    proc.onData((b) => received.push(b));
    proc.pushOutput("hello ");
    proc.pushOutput(Buffer.from("world"));
    expect(Buffer.concat(received).toString("utf8")).toBe("hello world");
  });

  it("emitExit fires onExit once even when called twice", async () => {
    const adapter = new MockPtyAdapter();
    const proc = (await adapter.spawn(baseInput)) as MockPtyProcess;
    const onExit = vi.fn();
    proc.onExit(onExit);
    proc.emitExit({ exitCode: 0, signal: null });
    proc.emitExit({ exitCode: 1, signal: null });
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("kill() synthesises an exit event with the requested signal", async () => {
    const adapter = new MockPtyAdapter();
    const proc = (await adapter.spawn(baseInput)) as MockPtyProcess;
    const events: Array<{ exitCode: number; signal: number | null }> = [];
    proc.onExit((e) => events.push(e));
    proc.kill(15);
    expect(events).toEqual([{ exitCode: 0, signal: 15 }]);
    expect(proc.killed).toBe(15);
  });

  it("write captures string + Uint8Array inputs in order", async () => {
    const adapter = new MockPtyAdapter();
    const proc = (await adapter.spawn(baseInput)) as MockPtyProcess;
    proc.write("abc");
    proc.write(new Uint8Array([1, 2, 3]));
    expect(proc.writeLog).toHaveLength(2);
    expect(proc.writeLog[0]).toBe("abc");
    expect(proc.writeLog[1]).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("resize logs every dimension change", async () => {
    const adapter = new MockPtyAdapter();
    const proc = (await adapter.spawn(baseInput)) as MockPtyProcess;
    proc.resize(100, 30);
    proc.resize(120, 40);
    expect(proc.resizeLog).toEqual([
      { cols: 100, rows: 30 },
      { cols: 120, rows: 40 },
    ]);
  });

  it("failNext throws a typed PtySpawnError on the next spawn only", async () => {
    const adapter = new MockPtyAdapter();
    adapter.failNext("shell_not_found", "no /bin/nope");
    await expect(adapter.spawn(baseInput)).rejects.toBeInstanceOf(PtySpawnError);
    // The next spawn should succeed since failNext is one-shot.
    const ok = await adapter.spawn(baseInput);
    expect(ok.pid).toBeGreaterThan(0);
  });

  it("syncUnsupported makes spawnSync throw sync_unsupported", () => {
    const adapter = new MockPtyAdapter({ syncUnsupported: true });
    try {
      adapter.spawnSync(baseInput);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PtySpawnError);
      expect((err as PtySpawnError).code).toBe("sync_unsupported");
    }
  });

  it("lastSpawned returns null before any spawn, then the most recent process", async () => {
    const adapter = new MockPtyAdapter();
    expect(adapter.lastSpawned()).toBeNull();
    const a = await adapter.spawn(baseInput);
    const b = await adapter.spawn(baseInput);
    expect(adapter.lastSpawned()).toBe(b);
    expect(adapter.spawned[0]).toBe(a);
  });

  it("onData disposers detach exactly that listener", async () => {
    const adapter = new MockPtyAdapter();
    const proc = (await adapter.spawn(baseInput)) as MockPtyProcess;
    const a: Buffer[] = [];
    const b: Buffer[] = [];
    const disposeA = proc.onData((buf) => a.push(buf));
    proc.onData((buf) => b.push(buf));
    proc.pushOutput("first");
    disposeA();
    proc.pushOutput("second");
    expect(Buffer.concat(a).toString()).toBe("first");
    expect(Buffer.concat(b).toString()).toBe("firstsecond");
  });

  it("post-exit onExit subscribers receive an inert disposer (no double-fire)", async () => {
    const adapter = new MockPtyAdapter();
    const proc = (await adapter.spawn(baseInput)) as MockPtyProcess;
    proc.emitExit({ exitCode: 0, signal: null });
    const late = vi.fn();
    const dispose = proc.onExit(late);
    expect(typeof dispose).toBe("function");
    expect(late).not.toHaveBeenCalled();
  });

  it("write after exit is a no-op (no throw, no log)", async () => {
    const adapter = new MockPtyAdapter();
    const proc = (await adapter.spawn(baseInput)) as MockPtyProcess;
    proc.emitExit({ exitCode: 0, signal: null });
    proc.write("late");
    expect(proc.writeLog).toEqual([]);
  });
});
