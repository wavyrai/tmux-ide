import { describe, it, expect } from "bun:test";
import { EventEmitter } from "node:events";
import type { Stats } from "node:fs";
import { terminalRespawnHandler } from "./terminal-respawn.ts";
import { PtyBridgeRegistry, type PtyBridgeLike } from "../../../server/ws-route.ts";

interface FakeBridgeOptions {
  cwd?: string | null;
  cols?: number | null;
  rows?: number | null;
  throwOnRestart?: Error;
}

class FakeBridge extends EventEmitter implements PtyBridgeLike {
  running = true;
  cols: number | null;
  rows: number | null;
  private cwd: string | null;
  private throwOnRestart?: Error;
  restartCalls: Array<{ cols: number; rows: number; cwd: string | undefined }> = [];

  constructor(options: FakeBridgeOptions = {}) {
    super();
    // `??` would collapse explicit `null` into the default — distinguish
    // null (intentionally no recorded cwd) from undefined (use the default).
    this.cwd = options.cwd !== undefined ? options.cwd : "/tmp/last";
    this.cols = options.cols ?? 80;
    this.rows = options.rows ?? 24;
    if (options.throwOnRestart) this.throwOnRestart = options.throwOnRestart;
  }

  spawn(): void {
    /* not used here */
  }

  restartWith(cols: number, rows: number, opts: { cwd?: string } = {}): void {
    if (this.throwOnRestart) throw this.throwOnRestart;
    this.restartCalls.push({ cols, rows, cwd: opts.cwd });
    if (opts.cwd) this.cwd = opts.cwd;
  }

  getCwd(): string | null {
    return this.cwd;
  }

  write(): void {
    /* unused */
  }
  resize(): void {
    /* unused */
  }
  pause(): void {
    /* unused */
  }
  resume(): void {
    /* unused */
  }
  kill(): void {
    this.running = false;
  }
}

function makeRegistry(id: string, bridge: PtyBridgeLike): PtyBridgeRegistry {
  const registry = new PtyBridgeRegistry();
  // Inject via acquire so the entry is bookkept correctly.
  registry.acquire(id, () => bridge, { idleMs: 0 });
  return registry;
}

const stat =
  (isDir: boolean): ((cwd: string) => Stats) =>
  () =>
    ({ isDirectory: () => isDir }) as Stats;

describe("terminalRespawnHandler", () => {
  it("respawns at the supplied cwd after validating it", () => {
    const bridge = new FakeBridge({ cwd: "/tmp/old" });
    const registry = makeRegistry("term-1", bridge);
    const result = terminalRespawnHandler(
      { sessionName: "demo", terminalId: "term-1", cwd: "/tmp/new" },
      { registry, statCwd: stat(true) },
    );
    expect(result).toEqual({ respawned: true, cwd: "/tmp/new" });
    expect(bridge.restartCalls).toEqual([{ cols: 80, rows: 24, cwd: "/tmp/new" }]);
  });

  it("falls back to the bridge's recorded cwd when none is supplied", () => {
    const bridge = new FakeBridge({ cwd: "/tmp/last" });
    const registry = makeRegistry("term-2", bridge);
    const result = terminalRespawnHandler(
      { sessionName: "demo", terminalId: "term-2" },
      { registry, statCwd: stat(true) },
    );
    expect(result.cwd).toBe("/tmp/last");
    expect(bridge.restartCalls[0]?.cwd).toBe("/tmp/last");
  });

  it("raises terminal_not_found when no bridge exists", () => {
    const registry = new PtyBridgeRegistry();
    expect(() =>
      terminalRespawnHandler(
        { sessionName: "demo", terminalId: "ghost" },
        { registry, statCwd: stat(true) },
      ),
    ).toThrow(/terminal_not_found|No running terminal/);
  });

  it("raises cwd_not_directory when the supplied cwd is a file", () => {
    const bridge = new FakeBridge();
    const registry = makeRegistry("term-3", bridge);
    let caught: unknown;
    try {
      terminalRespawnHandler(
        { sessionName: "demo", terminalId: "term-3", cwd: "/tmp/file" },
        { registry, statCwd: stat(false) },
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: string }).code).toBe("cwd_not_directory");
  });

  it("raises internal when the bridge has no recorded cwd and none is supplied", () => {
    const bridge = new FakeBridge({ cwd: null });
    const registry = makeRegistry("term-4", bridge);
    let caught: unknown;
    try {
      terminalRespawnHandler(
        { sessionName: "demo", terminalId: "term-4" },
        { registry, statCwd: stat(true) },
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: string }).code).toBe("internal");
  });

  it("wraps unexpected restart errors as internal", () => {
    const bridge = new FakeBridge({ throwOnRestart: new Error("kaboom") });
    const registry = makeRegistry("term-5", bridge);
    let caught: unknown;
    try {
      terminalRespawnHandler(
        { sessionName: "demo", terminalId: "term-5", cwd: "/tmp/new" },
        { registry, statCwd: stat(true) },
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: string }).code).toBe("internal");
  });
});
