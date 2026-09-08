import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createRenderer = vi.hoisted(() =>
  vi.fn(async (_options: Record<string, unknown>): Promise<Record<string, unknown>> => ({})),
);
const outputTransport = vi.hoisted(() => vi.fn());
vi.mock("./renderer-output-transport.ts", () => ({
  createRendererOutputTransport: outputTransport,
}));
vi.mock("@opentui/core", () => ({ createCliRenderer: createRenderer }));
import { createApplicationRootRenderer } from "./application-root-renderer.ts";

beforeEach(() => {
  vi.stubEnv("TMUX_IDE_FRAME_OUTPUT", undefined);
  vi.stubEnv("OTUI_DUMP_CAPTURES", undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("root renderer host capabilities", () => {
  it("disables the unsupported OSC 66 probe before constructing a tmux renderer", async () => {
    vi.stubEnv("TMUX", "/tmp/owned,123,0");
    vi.stubEnv("OPENTUI_FORCE_EXPLICIT_WIDTH", undefined);
    createRenderer.mockImplementationOnce(async () => {
      expect(process.env.OPENTUI_FORCE_EXPLICIT_WIDTH).toBe("false");
      return {};
    });
    await createApplicationRootRenderer(false);
    expect(createRenderer).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ forwardEnvKeys: ["OPENTUI_FORCE_EXPLICIT_WIDTH"] }),
    );
  });
  it("leaves direct terminal detection enabled", async () => {
    vi.stubEnv("TMUX", undefined);
    vi.stubEnv("OPENTUI_FORCE_EXPLICIT_WIDTH", undefined);
    await createApplicationRootRenderer(false);
    expect(process.env.OPENTUI_FORCE_EXPLICIT_WIDTH).toBeUndefined();
  });
  it.each(["true", "1", "false", "0"])("preserves explicit override %s", async (value) => {
    vi.stubEnv("TMUX", "/tmp/owned,123,0");
    vi.stubEnv("OPENTUI_FORCE_EXPLICIT_WIDTH", value);
    await createApplicationRootRenderer(false);
    expect(process.env.OPENTUI_FORCE_EXPLICIT_WIDTH).toBe(value);
  });
});

describe("root renderer diagnostic containment", () => {
  it.each([undefined, "1"])("contains errors in a bounded overlay with debug=%s", async (debug) => {
    vi.stubEnv("TMUX_IDE_MIRROR_DEBUG", debug);
    await createApplicationRootRenderer(false);
    expect(createRenderer).toHaveBeenCalledWith(
      expect.objectContaining({
        consoleMode: "console-overlay",
        openConsoleOnError: true,
        consoleOptions: {
          title: "tmux-ide diagnostics",
          maxStoredLogs: 100,
          maxDisplayLines: 500,
        },
      }),
    );
  });

  it("releases captured Error references when the renderer is destroyed", async () => {
    const clear = vi.fn();
    createRenderer.mockResolvedValueOnce({ console: { clear } });
    await createApplicationRootRenderer(false);
    expect(clear).not.toHaveBeenCalled();
    (createRenderer.mock.calls.at(-1)![0].onDestroy as () => void)();
    expect(clear).toHaveBeenCalledExactlyOnceWith();
  });

  it.each(["1", "TRUE", "on", "yes"])(
    "preserves the explicit post-exit capture dump (%s)",
    async (value) => {
      vi.stubEnv("OTUI_DUMP_CAPTURES", value);
      const clear = vi.fn();
      createRenderer.mockResolvedValueOnce({ console: { clear } });
      await createApplicationRootRenderer(false);
      (createRenderer.mock.calls.at(-1)![0].onDestroy as () => void)();
      expect(clear).not.toHaveBeenCalled();
    },
  );
});

describe("root renderer frame-output experiment", () => {
  function setupTransport() {
    vi.stubEnv("TMUX_IDE_FRAME_OUTPUT", "1");
    const stdout = Object.assign(
      new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      }),
      {
        columns: 120,
        rows: 40,
        isTTY: true,
      },
    );
    const dispose = vi.fn();
    outputTransport.mockReturnValueOnce({ stdout, dispose });
    return { stdout, dispose };
  }

  function onDestroy() {
    return createRenderer.mock.calls.at(-1)![0].onDestroy as () => void;
  }

  it.each([undefined, "0", "true"])(
    "retains native stdout unless explicitly enabled (%s)",
    async (value) => {
      vi.stubEnv("TMUX_IDE_FRAME_OUTPUT", value);
      await createApplicationRootRenderer(false);
      expect(outputTransport).not.toHaveBeenCalled();
      expect(createRenderer.mock.calls[0]![0]).not.toHaveProperty("stdout");
    },
  );

  it("passes the custom stdout with local capability detection when opted in", async () => {
    const { stdout, dispose } = setupTransport();
    await createApplicationRootRenderer(true);
    expect(createRenderer).toHaveBeenCalledWith(
      expect.objectContaining({
        stdout,
        remote: false,
        onDestroy: expect.any(Function),
        useKittyKeyboard: {},
      }),
    );
    expect(dispose).not.toHaveBeenCalled();
    onDestroy()();
  });

  it("debounces resize bursts and reads the latest positive terminal dimensions", async () => {
    vi.useFakeTimers();
    const { stdout } = setupTransport();
    const resize = vi.fn();
    createRenderer.mockResolvedValueOnce({ resize });
    await createApplicationRootRenderer(false);
    stdout.emit("resize");
    await vi.advanceTimersByTimeAsync(70);
    stdout.columns = 100;
    stdout.rows = 35;
    stdout.emit("resize");
    await vi.advanceTimersByTimeAsync(99);
    expect(resize).not.toHaveBeenCalled();
    // Dimensions are read at flush time, not captured by the earlier event.
    stdout.columns = 90;
    stdout.rows = 30;
    await vi.advanceTimersByTimeAsync(1);
    expect(resize).toHaveBeenCalledExactlyOnceWith(90, 30);
    for (const [columns, rows] of [
      [0, 30],
      [90, 0],
      [-1, 30],
    ]) {
      Object.assign(stdout, { columns, rows });
      stdout.emit("resize");
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(resize).toHaveBeenCalledTimes(1);
    onDestroy()();
  });

  it("disposes transport if renderer construction fails while preserving the failure", async () => {
    const { stdout, dispose } = setupTransport();
    const error = new Error("renderer construction failed");
    createRenderer.mockRejectedValueOnce(error);
    await expect(createApplicationRootRenderer(false)).rejects.toBe(error);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(stdout.listenerCount("resize")).toBe(0);
    expect(stdout.destroyed).toBe(false);
  });

  it("cancels pending resize work and removes only its own listener on destruction", async () => {
    vi.useFakeTimers();
    const { stdout, dispose } = setupTransport();
    const resize = vi.fn();
    const otherResize = vi.fn();
    stdout.on("resize", otherResize);
    createRenderer.mockResolvedValueOnce({ resize });
    await createApplicationRootRenderer(false);
    stdout.emit("resize");
    onDestroy()();
    await vi.advanceTimersByTimeAsync(100);
    expect(resize).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(stdout.listenerCount("resize")).toBe(1);
    stdout.emit("resize");
    await vi.advanceTimersByTimeAsync(100);
    expect(resize).not.toHaveBeenCalled();
    expect(otherResize).toHaveBeenCalledTimes(2);
    expect(stdout.destroyed).toBe(false);
  });

  it("tears down once after a live output failure without losing the diagnostic", async () => {
    const diagnostic = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { stdout, dispose } = setupTransport();
    const destroy = vi.fn();
    createRenderer.mockResolvedValueOnce({ destroy });
    await createApplicationRootRenderer(false);
    stdout.emit("error", new Error("TTY disconnected"));
    stdout.emit("error", new Error("duplicate failure"));
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
      "tmux-ide: terminal output failed; closing the TUI.\n",
    );
    // Complete the renderer's normal destruction callback.
    onDestroy()();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(stdout.listenerCount("error")).toBe(0);
  });

  it("rejects and destroys a renderer whose output failed during construction", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { stdout, dispose } = setupTransport();
    const error = new Error("output failed during terminal setup");
    const destroy = vi.fn(() => onDestroy()());
    const lifecycleShutdown = vi.fn(async () => {});
    createRenderer.mockImplementationOnce(async () => {
      stdout.emit("error", error);
      return { destroy };
    });
    await expect(createApplicationRootRenderer(false, lifecycleShutdown)).rejects.toBe(error);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalled();
    expect(lifecycleShutdown).not.toHaveBeenCalled();
    expect(stdout.listenerCount("resize")).toBe(0);
    expect(stdout.listenerCount("error")).toBe(0);
  });

  it("destroys if output fails before the lifecycle is available", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { stdout } = setupTransport();
    const destroy = vi.fn();
    createRenderer.mockResolvedValueOnce({ destroy });
    await createApplicationRootRenderer(false, () => undefined);
    stdout.emit("error", new Error("TTY closed"));
    expect(destroy).toHaveBeenCalledTimes(1);
    onDestroy()();
  });

  it("lets the lifecycle callback own live failure shutdown instead of destroying twice", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { stdout, dispose } = setupTransport();
    const error = new Error("TTY closed");
    const destroy = vi.fn();
    const lifecycleShutdown = vi.fn(async () => {});
    createRenderer.mockResolvedValueOnce({ destroy });
    await createApplicationRootRenderer(false, lifecycleShutdown);
    stdout.emit("error", error);
    stdout.emit("error", new Error("second error"));
    expect(lifecycleShutdown).toHaveBeenCalledExactlyOnceWith(error);
    expect(destroy).not.toHaveBeenCalled();
    onDestroy()();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
