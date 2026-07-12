import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  HOST_AUTOWRAP_DISABLE,
  HOST_AUTOWRAP_ENABLE,
  installHostAutowrapGuard,
  type HostTerminalExitLifecycle,
} from "./host-terminal.ts";
import { PaneMirror } from "./pane-mirror.ts";

function harness() {
  const events = new EventEmitter();
  const writes: string[] = [];
  const lifecycle: HostTerminalExitLifecycle = {
    onExit: (listener) => events.once("exit", listener),
    offExit: (listener) => events.removeListener("exit", listener),
  };
  return { events, writes, lifecycle };
}

async function waitForLine(mirror: PaneMirror, needle: string): Promise<string[]> {
  for (let i = 0; i < 50; i++) {
    const lines = mirror.bufferLines();
    if (lines.some((line) => line.includes(needle))) return lines;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return mirror.bufferLines();
}

describe("installHostAutowrapGuard", () => {
  it("disables autowrap immediately and restores it on renderer teardown", () => {
    const h = harness();
    const guard = installHostAutowrapGuard((sequence) => h.writes.push(sequence), h.lifecycle);

    expect(h.writes).toEqual([HOST_AUTOWRAP_DISABLE]);
    expect(h.events.listenerCount("exit")).toBe(1);

    guard.restore();

    expect(h.writes).toEqual([HOST_AUTOWRAP_DISABLE, HOST_AUTOWRAP_ENABLE]);
    expect(h.events.listenerCount("exit")).toBe(0);
  });

  it("restores through the process-exit fallback", () => {
    const h = harness();
    installHostAutowrapGuard((sequence) => h.writes.push(sequence), h.lifecycle);

    h.events.emit("exit");

    expect(h.writes).toEqual([HOST_AUTOWRAP_DISABLE, HOST_AUTOWRAP_ENABLE]);
    expect(h.events.listenerCount("exit")).toBe(0);
  });

  it("restores exactly once across repeated teardown and exit paths", () => {
    const h = harness();
    const guard = installHostAutowrapGuard((sequence) => h.writes.push(sequence), h.lifecycle);

    guard.restore();
    guard.restore();
    h.events.emit("exit");

    expect(h.writes).toEqual([HOST_AUTOWRAP_DISABLE, HOST_AUTOWRAP_ENABLE]);
  });

  it("pins right-edge writes while active and restores normal wrapping", async () => {
    const h = harness();
    const mirror = new PaneMirror(10, 3);
    const guard = installHostAutowrapGuard((sequence) => mirror.write(sequence), h.lifecycle);

    // With DECAWM disabled, a second printable at the final column overwrites
    // that cell instead of leaking into column 1 of the next row.
    mirror.write("\x1b[1;10HXY");
    expect(await waitForLine(mirror, "Y")).toEqual(["         Y", "", ""]);

    guard.restore();
    mirror.write("\x1b[2;10HZW");
    expect(await waitForLine(mirror, "W")).toEqual(["         Y", "         Z", "W"]);

    mirror.dispose();
  });
});
