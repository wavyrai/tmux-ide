import * as childProcess from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOpenTuiHostLocalTmuxAdapter,
  writeAllSync,
  writeMacClipboard,
} from "./host-local-tmux-adapter.ts";
import { applicationClipboardReadiness } from "./application-terminal-selection-owner.ts";

// Never allow clipboard fixtures to launch a real host process, even on regression.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(() => {
    throw new Error("Unexpected real subprocess in clipboard test");
  }),
}));

const source = readFileSync(
  fileURLToPath(new URL("./host-local-tmux-adapter.ts", import.meta.url)),
  "utf8",
);

describe("host-local tmux adapter boundary", () => {
  beforeEach(() => {
    vi.stubEnv("TMUX", "/private/test-tmux,123,0");
    vi.stubEnv("SSH_TTY", "/private/test-ssh");
  });
  afterEach(() => vi.unstubAllEnvs());
  it("contains only clipboard policy commands", () => {
    expect(source.match(/run\(\[/gu)).toBeNull();
    expect(source.match(/boundedClipboardPolicyRun\(run,/gu)).toHaveLength(2);
    expect(source).toContain('["set-option", "-gq", "set-clipboard", "on"]');
    expect(source).toContain('["set-option", "-gq", "allow-passthrough", "on"]');
    for (const forbidden of [
      "switch-client",
      "detach-client",
      "new-session",
      "new-window",
      "split-window",
      "kill-pane",
      "resize-pane",
      "select-pane",
      "send-keys",
    ]) {
      expect(source).not.toContain(`"${forbidden}"`);
    }
  });

  it("owns clipboard policy behind one capability", async () => {
    const calls: string[][] = [];
    const adapter = createOpenTuiHostLocalTmuxAdapter(true, async (args) => calls.push([...args]));
    expect(adapter.hosted).toBe(true);
    await expect(adapter.configureClipboard()).resolves.toBe(true);
    expect(calls).toEqual([
      ["set-option", "-gq", "set-clipboard", "on"],
      ["set-option", "-gq", "allow-passthrough", "on"],
    ]);
  });

  it("fails copy before readiness and writes the exact bounded OSC52 payload after readiness", async () => {
    const writes: string[] = [];
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    const adapter = createOpenTuiHostLocalTmuxAdapter(
      true,
      async () => pending,
      (sequence) => (writes.push(sequence), true),
    );
    const configured = adapter.configureClipboard();
    expect(adapter.copyText("copy me")).toBe(false);
    release();
    await expect(configured).resolves.toBe(true);
    expect(adapter.copyText("copy me")).toBe(true);
    expect(writes).toEqual(["\u001b]52;c;Y29weSBtZQ==\u0007"]);
  });

  it("copies outside tmux even when root skips policy readiness", async () => {
    const policy = vi.fn(async () => undefined);
    const writeClipboard = vi.fn(() => true);
    const adapter = createOpenTuiHostLocalTmuxAdapter(false, policy, writeClipboard, false);
    await expect(applicationClipboardReadiness(adapter.configureClipboard, false)).resolves.toBe(
      undefined,
    );
    expect(policy).not.toHaveBeenCalled();
    expect(adapter.copyText("copy me")).toBe(true);
    expect(writeClipboard).toHaveBeenCalledWith("\u001b]52;c;Y29weSBtZQ==\u0007");
    await expect(adapter.configureClipboard()).resolves.toBe(true);
    expect(policy).not.toHaveBeenCalled();
  });

  it("honors explicit OSC52 routing on a local host without starting a native helper", async () => {
    vi.stubEnv("SSH_TTY", "");
    vi.stubEnv("SSH_CONNECTION", "");
    vi.stubEnv("TMUX_IDE_CLIPBOARD_BACKEND", "osc52");
    const launch = vi.mocked(childProcess.execFile);
    launch.mockClear();
    try {
      const writeClipboard = vi.fn(() => true);
      const adapter = createOpenTuiHostLocalTmuxAdapter(
        false,
        async () => undefined,
        writeClipboard,
        false,
      );
      const copied = adapter.copyText("route through terminal");
      await Promise.resolve();
      expect(copied).toBe(true);
      expect(writeClipboard).toHaveBeenCalledWith(
        "\u001b]52;c;cm91dGUgdGhyb3VnaCB0ZXJtaW5hbA==\u0007",
      );
      expect(launch).not.toHaveBeenCalled();
    } finally {
      launch.mockClear();
    }
  });

  it("handles partial writes exactly and fails on a stalled writer", () => {
    const chunks: number[] = [];
    expect(
      writeAllSync(9, Buffer.from("abcdef"), ((_fd, _buffer, offset, length) => {
        const written = Math.min(2, length);
        chunks.push(offset, written);
        return written;
      }) as typeof import("node:fs").writeSync),
    ).toBe(true);
    expect(chunks).toEqual([0, 2, 2, 2, 4, 2]);
    expect(writeAllSync(9, Buffer.from("x"), (() => 0) as typeof import("node:fs").writeSync)).toBe(
      false,
    );
  });

  it("bounds clipboard readiness even when the policy runner retains a handle", async () => {
    vi.useFakeTimers();
    try {
      const adapter = createOpenTuiHostLocalTmuxAdapter(
        true,
        async () => await new Promise(() => undefined),
      );
      const configured = adapter.configureClipboard();
      await vi.advanceTimersByTimeAsync(1_500);
      await expect(configured).resolves.toBe(false);
      expect(adapter.copyText("never")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains the hosted marker without exposing client mutation", () => {
    const adapter = createOpenTuiHostLocalTmuxAdapter(false);
    expect(adapter.hosted).toBe(false);
    expect(adapter).not.toHaveProperty("putAway");
  });
});

describe("native macOS clipboard", () => {
  it.skipIf(process.platform !== "darwin")(
    "selects native clipboard by default outside tmux and waits for its actual completion",
    async () => {
      for (const variable of ["TMUX", "SSH_TTY", "SSH_CONNECTION", "TMUX_IDE_CLIPBOARD_BACKEND"])
        vi.stubEnv(variable, undefined);
      const launch = vi.mocked(childProcess.execFile);
      let finish!: (error: Error | null) => void;
      const end = vi.fn();
      const fakeLaunch = (
        _path: unknown,
        _args: unknown,
        _options: unknown,
        callback: (error: Error | null) => void,
      ) => {
        finish = callback;
        return { kill: vi.fn(), stdin: { on: vi.fn(), end } };
      };
      launch.mockImplementationOnce(fakeLaunch as unknown as typeof childProcess.execFile);
      try {
        const policy = vi.fn(async () => undefined);
        const osc = vi.fn(() => true);
        const adapter = createOpenTuiHostLocalTmuxAdapter(false, policy, osc);
        await applicationClipboardReadiness(adapter.configureClipboard, false);
        let settled = false;
        const result = adapter.copyText("local selection λ\n");
        const observed = Promise.resolve(result).then((copied) => {
          settled = true;
          return copied;
        });
        await Promise.resolve();
        expect(launch).toHaveBeenCalledWith(
          "/usr/bin/pbcopy",
          [],
          { timeout: 1500, killSignal: "SIGKILL", maxBuffer: 4096 },
          expect.any(Function),
        );
        expect(end).toHaveBeenCalledWith("local selection λ\n", "utf8");
        expect(settled).toBe(false);
        expect(policy).not.toHaveBeenCalled();
        expect(osc).not.toHaveBeenCalled();
        finish(null);
        await expect(observed).resolves.toBe(true);
      } finally {
        vi.unstubAllEnvs();
        launch.mockReset();
        launch.mockImplementation(() => {
          throw new Error("Unexpected real subprocess in clipboard test");
        });
      }
    },
  );

  it("waits for helper completion and rejects failed exit or stdin", async () => {
    for (const failure of ["none", "exit", "stdin"] as const) {
      let finish!: (error: Error | null) => void;
      let inputError!: () => void;
      const end = vi.fn();
      const launch = vi.fn((_path, _args, options, callback) => {
        expect(options).toEqual({ timeout: 1500, killSignal: "SIGKILL", maxBuffer: 4096 });
        finish = callback;
        return {
          kill: vi.fn(),
          stdin: {
            on: (_event: string, handler: () => void) => {
              inputError = handler;
            },
            end,
          },
        };
      });
      const result = writeMacClipboard(
        "exact unicode λ\n",
        launch as unknown as typeof import("node:child_process").execFile,
      );
      expect(launch.mock.calls[0]?.slice(0, 2)).toEqual(["/usr/bin/pbcopy", []]);
      expect(end).toHaveBeenCalledWith("exact unicode λ\n", "utf8");
      if (failure === "stdin") inputError();
      finish(failure === "exit" ? new Error("timed out or nonzero exit") : null);
      await expect(result).resolves.toBe(failure === "none");
    }
  });

  it("serializes native copies, retains only the latest pending text and recovers after failure", async () => {
    let finish!: (value: boolean) => void;
    const native = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const policy = vi.fn(async () => undefined);
    const osc = vi.fn(() => true);
    const adapter = createOpenTuiHostLocalTmuxAdapter(false, policy, osc, false, native);
    const result = adapter.copyText("first");
    await Promise.resolve();
    const superseded = adapter.copyText("superseded");
    const newest = adapter.copyText("newest");
    await expect(superseded).resolves.toBe(false);
    expect(adapter.copyText("x".repeat(1_000_001))).toBe(false);
    expect(native).toHaveBeenCalledTimes(1);
    finish(false);
    await expect(result).resolves.toBe(false);
    await Promise.resolve();
    expect(native).toHaveBeenNthCalledWith(2, "newest");
    finish(true);
    await expect(newest).resolves.toBe(true);
    const next = adapter.copyText("next");
    await Promise.resolve();
    finish(true);
    await expect(next).resolves.toBe(true);
    expect(osc).not.toHaveBeenCalled();
    expect(policy).not.toHaveBeenCalled();
  });
});
