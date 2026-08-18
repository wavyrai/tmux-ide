import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { OPENTUI_PRODUCTION_ROOT_SOURCES } from "../../../../test-support/opentui-production-root-manifest.ts";
import {
  abandonPreparedConnection,
  createApplicationShellDiagnosticHandoff,
  explicitApplicationTarget,
  prepareExplicitApplicationTarget,
} from "./application-entry.ts";

const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url));
const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");

describe("production OpenTUI entry boundary", () => {
  it("keeps the public app entry genuinely tiny", () => {
    const source = read("packages/daemon/src/tui/mirror/app.tsx");
    expect(source.trim().split("\n")).toHaveLength(3);
    expect(source).toContain('from "./runtime/application-entry.ts"');
    expect(source).toContain("await startApplicationEntry()");
  });

  it("loads the production root through a Bun-discoverable literal import", () => {
    const source = read("packages/daemon/src/tui/mirror/runtime/application-entry.ts");
    expect(source).toContain('await import("./application-root-v2.tsx")');
    expect(source).not.toContain('import("./application-root.tsx")');
    expect(source).not.toMatch(/from\s+["']\.\/application-root(?:-v2)?/u);
  });

  it("injects application-shell evidence only when the existing perf writer is enabled", () => {
    const entry = read("packages/daemon/src/tui/mirror/runtime/application-entry.ts");
    const root = read("packages/daemon/src/tui/mirror/runtime/application-root-v2.tsx");
    expect(entry).toMatch(
      /diagnosticLog\s*\?\s*prepareOpenTuiApplicationShellConnection[\s\S]*onDiagnostic:[\s\S]*:\s*prepareOpenTuiApplicationShellConnection/u,
    );
    expect(root).toMatch(
      /tuiPerfStream\s*\?\s*prepareOpenTuiApplicationShellConnection[\s\S]*onDiagnostic:\s*tuiPerfMark[\s\S]*:\s*prepareOpenTuiApplicationShellConnection/u,
    );
  });

  it("hands early diagnostics to one ordered bounded root sink", () => {
    const handoff = createApplicationShellDiagnosticHandoff(Date.now(), 2);
    const received: Array<{ phase: string; details: Readonly<Record<string, unknown>> }> = [];
    handoff.emit("first", { ordinal: 0 });
    handoff.emit("second", { ordinal: 1 });
    handoff.emit("overflow", { ordinal: 2 });
    handoff.attach((phase, details) => received.push({ phase, details }));
    handoff.emit("after-attach", { ordinal: 3 });

    expect(received.map(({ phase }) => phase)).toEqual([
      "first",
      "second",
      "application-shell-diagnostic-handoff",
      "after-attach",
    ]);
    expect(received[2]?.details).toEqual({ outcome: "dropped", count: 1 });
    expect(received[0]?.details).toMatchObject({ ordinal: 0 });
    expect(received[0]?.details.causalMonotonicMicros).toEqual(expect.any(Number));
  });

  it("fences late preparation evidence before the root sink closes", () => {
    const handoff = createApplicationShellDiagnosticHandoff(Date.now());
    const sink = vi.fn();
    handoff.attach(sink);
    handoff.emit("before-retire", { ordinal: 0 });
    handoff.retire();
    const now = vi.spyOn(performance, "now").mockImplementation(() => {
      throw new Error("retired diagnostics must do no work");
    });
    try {
      handoff.emit("late-preparation-settlement", { ordinal: 1 });
    } finally {
      now.mockRestore();
    }
    expect(sink).toHaveBeenCalledOnce();
    expect(sink).toHaveBeenCalledWith("before-retire", expect.objectContaining({ ordinal: 0 }));
  });

  it("disposes a late prepared connection without writing after sink retirement", async () => {
    const handoff = createApplicationShellDiagnosticHandoff(Date.now());
    const sink = vi.fn();
    handoff.attach(sink);
    let resolvePrepared!: (connection: { dispose(): void }) => void;
    const pending = new Promise<{ dispose(): void }>((resolve) => {
      resolvePrepared = resolve;
    });
    const dispose = vi.fn(() => {
      handoff.emit("application-shell-prewarm-settled", { outcome: "aborted" });
    });
    abandonPreparedConnection(pending);

    handoff.retire();
    handoff.emit("application-shell-prewarm-start", { ordinal: 0 });
    resolvePrepared({ dispose });
    await Promise.resolve();
    await Promise.resolve();

    expect(dispose).toHaveBeenCalledOnce();
    expect(sink).not.toHaveBeenCalled();
  });

  it("attaches before root work and closes the shared stream after connection retirement", () => {
    const root = read("packages/daemon/src/tui/mirror/runtime/application-root-v2.tsx");
    expect(root.indexOf("diagnosticHandoff?.attach(tuiPerfMark)")).toBeLessThan(
      root.indexOf("await startTuiApplication"),
    );
    expect(root.indexOf("await sessionOwner?.dispose()")).toBeGreaterThan(0);
    expect(root.indexOf("await sessionOwner?.dispose()")).toBeLessThan(
      root.indexOf("diagnosticHandoff?.retire()"),
    );
    expect(root.indexOf("diagnosticHandoff?.retire()")).toBeLessThan(
      root.indexOf("await closeTuiPerfMarks()"),
    );
  });

  it("does not install generation diagnostics when the performance stream is disabled", () => {
    const root = read("packages/daemon/src/tui/mirror/runtime/application-root-v2.tsx");
    const host = read("packages/daemon/src/tui/mirror/runtime/open-tui-generation-host.ts");
    expect(root).toMatch(
      /createOpenTuiGenerationHost[\s\S]*\.\.\.\(tuiPerfStream[\s\S]*onDiagnostic/u,
    );
    expect(host).not.toContain("onDiagnostic: () => undefined");
    expect(host).toContain("const diagnose = overrides.onDiagnostic");
    expect(host).toContain('diagnose?.("host-internal-snapshot-publication"');
  });

  it("installs frame readiness only for an explicit lifecycle or detailed diagnostic sink", () => {
    const root = read("packages/daemon/src/tui/mirror/runtime/application-root-v2.tsx");
    expect(root).toMatch(
      /terminalFrameReadiness\s*=\s*tuiPerfStream\s*\|\|\s*frameDiagnosticSink[\s\S]*createTerminalFrameReadiness/u,
    );
    expect(root).toContain(
      'if (terminalFrameReadiness) renderer.on("frame", observeTerminalFrame)',
    );
  });

  it("manifests every bootstrap boundary used to seed transitive architecture audits", () => {
    expect(OPENTUI_PRODUCTION_ROOT_SOURCES).toEqual([
      "packages/daemon/src/tui/mirror/app.tsx",
      "packages/daemon/src/tui/mirror/runtime/application-entry.ts",
      "packages/daemon/src/tui/mirror/runtime/application-root-v2.tsx",
    ]);
    for (const path of OPENTUI_PRODUCTION_ROOT_SOURCES)
      expect(read(path).length).toBeGreaterThan(0);
  });

  it("prewarms only an explicit session target, never Home", async () => {
    const prepare = vi.fn(async (sessionName: string) => `prepared:${sessionName}`);
    expect(explicitApplicationTarget(["app", "--target=alpha"])).toBe("alpha");
    expect(explicitApplicationTarget(["app", "alpha"])).toBe("alpha");
    expect(prepareExplicitApplicationTarget(["app"], prepare)).toBeNull();
    expect(prepareExplicitApplicationTarget(["app", "home"], prepare)).toBeNull();
    expect(prepare).not.toHaveBeenCalled();

    const explicit = prepareExplicitApplicationTarget(["app", "--target=alpha"], prepare);
    expect(explicit?.sessionName).toBe("alpha");
    await expect(explicit?.prepared).resolves.toBe("prepared:alpha");
    expect(prepare).toHaveBeenCalledOnce();
  });

  it("abandons preparation without waiting and disposes a late success", async () => {
    let resolvePrepared!: (value: { dispose(): void }) => void;
    const pending = new Promise<{ dispose(): void }>((resolve) => {
      resolvePrepared = resolve;
    });
    const dispose = vi.fn();

    expect(abandonPreparedConnection(pending)).toBeUndefined();
    resolvePrepared({ dispose });
    await Promise.resolve();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("continues cleanup synchronously when preparation never settles", async () => {
    const neverSettles = new Promise<{ dispose(): void }>(() => undefined);

    expect(abandonPreparedConnection(neverSettles)).toBeUndefined();
    await expect(Promise.resolve("cleanup-continued")).resolves.toBe("cleanup-continued");
  });

  it("observes a late preparation rejection without blocking cleanup", async () => {
    let rejectPrepared!: (error: Error) => void;
    const pending = new Promise<{ dispose(): void }>((_resolve, reject) => {
      rejectPrepared = reject;
    });

    expect(abandonPreparedConnection(pending)).toBeUndefined();
    rejectPrepared(new Error("late route failure"));
    await Promise.resolve();
  });
});
