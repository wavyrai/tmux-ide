import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

let directory: string | null = null;
let logger: typeof import("./application-performance-log.ts") | null = null;
afterEach(async () => {
  await logger?.closeTuiPerfMarks();
  logger = null;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = null;
  vi.unstubAllEnvs();
  vi.resetModules();
});

it.each([false, true])(
  "keeps lifecycle logging separate from detailed tracing (explicit: %s)",
  async (explicit) => {
    directory = await mkdtemp(join(tmpdir(), "tmi-log-mode-"));
    const automatic = join(directory, "automatic.jsonl");
    const detailed = join(directory, "trace.jsonl");
    vi.stubEnv("TMUX_IDE_TUI_LOG", automatic);
    vi.stubEnv("TMUX_IDE_TUI_PERF_LOG", explicit ? detailed : undefined);
    vi.resetModules();
    logger = await import("./application-performance-log.ts");
    expect(logger.tuiLifecycleStream).not.toBeNull();
    expect(Boolean(logger.tuiPerfStream)).toBe(explicit);
    expect(Boolean(logger.tuiPerfWheelObservation)).toBe(explicit);
    logger.markGenerationStatus({ status: "connecting", daemonGeneration: null });
    logger.markGenerationStatus({ status: "connecting", daemonGeneration: null });
    logger.tuiPerfMark("generation-runtime-fault", { message: "connection closed" });
    logger.tuiPerfMark("generation-runtime-progress", { runtimePhase: "coherent" });
    for (const phase of [
      "renderer-frame",
      "terminal-wheel-route",
      "resource-snapshot",
      "generation-runtime-progress",
    ]) {
      logger.tuiPerfMark(phase, { runtimePhase: "compact-decode", expandedCells: 66 });
    }
    logger.markTerminalHostFocusControlGate({ enabled: explicit });
    logger.markTerminalHostFocusBinding({ bindingEpoch: 1 });
    await logger.closeTuiPerfMarks();
    logger = null;
    const records = (await readFile(explicit ? detailed : automatic, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.filter((record) => record.phase === "generation-status")).toHaveLength(
      explicit ? 2 : 1,
    );
    expect(
      records.some(
        (record) =>
          record.phase === "generation-runtime-fault" && record.message === "connection closed",
      ),
    ).toBe(true);
    expect(records.some((record) => record.runtimePhase === "coherent")).toBe(true);
    expect(records.some((record) => record.runtimePhase === "compact-decode")).toBe(explicit);
    expect(
      records.some((record) => record.phase === "terminal-host-focus-control-binding-ready"),
    ).toBe(explicit);
    expect(
      records.some((record) => record.phase === "terminal-host-focus-control-gate-ready"),
    ).toBe(true);
    if (explicit) await expect(readFile(automatic)).rejects.toThrow();
  },
);
