import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { publishTuiInputReady } from "./readiness.ts";
import { OPENTUI_PRODUCTION_ROOT_SOURCES } from "../../test-support/opentui-production-root-manifest.ts";

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
    const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
    const source = OPENTUI_PRODUCTION_ROOT_SOURCES.map((path) =>
      readFileSync(join(repoRoot, path), "utf8"),
    ).join("\n");
    const keyboard = source.indexOf("useKeyboard((event) =>");
    const paste = source.indexOf("usePaste((event) =>", keyboard);
    const mounted = source.indexOf("onMount(() =>", paste);
    const inputBarrier = source.indexOf("resolveReady()", mounted);
    const ready = source.indexOf('publishTuiInputReady("app")', inputBarrier);

    expect(keyboard).toBeGreaterThan(-1);
    expect(paste).toBeGreaterThan(keyboard);
    expect(mounted).toBeGreaterThan(paste);
    expect(inputBarrier).toBeGreaterThan(mounted);
    expect(ready).toBeGreaterThan(inputBarrier);
  });
});
