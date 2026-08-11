import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishTuiInputReady } from "./readiness.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("TUI input readiness", () => {
  it("is inert unless a launcher requests the handshake", () => {
    expect(publishTuiInputReady("app", { path: "" })).toBeNull();
  });

  it("atomically publishes a versioned input-ready record", () => {
    const root = mkdtempSync(join(tmpdir(), "tmux-ide-tui-ready-"));
    roots.push(root);
    const path = join(root, "nested", "ready.json");
    const now = new Date("2026-08-12T08:00:00.000Z");

    expect(publishTuiInputReady("app", { path, pid: 42, now })).toEqual({
      version: 1,
      phase: "input-ready",
      surface: "app",
      pid: 42,
      at: now.toISOString(),
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      version: 1,
      phase: "input-ready",
      surface: "app",
      pid: 42,
      at: now.toISOString(),
    });
    expect(existsSync(`${path}.42.tmp`)).toBe(false);
  });

  it("publishes the app barrier after its root keyboard and paste owners mount", () => {
    const source = readFileSync(new URL("./mirror/app.tsx", import.meta.url), "utf8");
    const keyboard = source.indexOf("useKeyboard((evt) =>");
    const paste = source.indexOf("usePaste((e) =>", keyboard);
    const inputBarrier = source.indexOf("resolveInputReady()", paste);
    const ready = source.indexOf('publishTuiInputReady("app")', inputBarrier);

    expect(keyboard).toBeGreaterThan(-1);
    expect(paste).toBeGreaterThan(keyboard);
    expect(inputBarrier).toBeGreaterThan(paste);
    expect(ready).toBeGreaterThan(inputBarrier);
  });
});
