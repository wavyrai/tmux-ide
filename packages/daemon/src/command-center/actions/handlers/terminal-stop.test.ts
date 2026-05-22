import { describe, it, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { terminalStopHandler } from "./terminal-stop.ts";
import { PtyBridgeRegistry, type PtyBridgeLike } from "../../../server/ws-route.ts";

class StubBridge extends EventEmitter implements PtyBridgeLike {
  running = true;
  killed = 0;
  spawn(): void {}
  write(): void {}
  resize(): void {}
  pause(): void {}
  resume(): void {}
  kill(): void {
    this.killed++;
    this.running = false;
  }
}

describe("terminalStopHandler", () => {
  it("kills the bridge and removes it from the registry", () => {
    const registry = new PtyBridgeRegistry();
    const bridge = new StubBridge();
    registry.acquire("term-1", () => bridge, { idleMs: 0 });
    const result = terminalStopHandler({ sessionName: "demo", terminalId: "term-1" }, { registry });
    expect(result).toEqual({ stopped: true });
    expect(bridge.killed).toBe(1);
    expect(registry.size()).toBe(0);
  });

  it("raises terminal_not_found when no bridge is registered", () => {
    const registry = new PtyBridgeRegistry();
    let caught: unknown;
    try {
      terminalStopHandler({ sessionName: "demo", terminalId: "ghost" }, { registry });
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: string }).code).toBe("terminal_not_found");
  });
});
