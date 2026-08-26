import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createOpenTuiHostLocalTmuxAdapter, writeAllSync } from "./host-local-tmux-adapter.ts";
import { applicationClipboardReadiness } from "./application-terminal-selection-owner.ts";

const source = readFileSync(
  fileURLToPath(new URL("./host-local-tmux-adapter.ts", import.meta.url)),
  "utf8",
);

describe("host-local tmux adapter boundary", () => {
  it("contains only client-local put-away and clipboard policy commands", () => {
    expect(source.match(/run\(\[/gu)).toHaveLength(2);
    expect(source.match(/boundedClipboardPolicyRun\(run,/gu)).toHaveLength(2);
    expect(source).toContain('["switch-client", "-l"]');
    expect(source).toContain('["detach-client"]');
    expect(source).toContain('["set-option", "-gq", "set-clipboard", "on"]');
    expect(source).toContain('["set-option", "-gq", "allow-passthrough", "on"]');
    for (const forbidden of [
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

  it("owns switch-back fallback and clipboard policy behind one capability", async () => {
    const calls: string[][] = [];
    const adapter = createOpenTuiHostLocalTmuxAdapter(true, async (args) => {
      calls.push([...args]);
      if (args[0] === "switch-client") throw new Error("no prior client");
    });
    expect(adapter.hosted).toBe(true);
    await expect(adapter.configureClipboard()).resolves.toBe(true);
    await adapter.putAway();
    expect(calls).toEqual([
      ["set-option", "-gq", "set-clipboard", "on"],
      ["set-option", "-gq", "allow-passthrough", "on"],
      ["switch-client", "-l"],
      ["detach-client"],
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

  it("a cleared TMUX readiness contract emits no OSC52 and no policy request", async () => {
    const policy = vi.fn(async () => undefined);
    const writeClipboard = vi.fn(() => true);
    const adapter = createOpenTuiHostLocalTmuxAdapter(true, policy, writeClipboard);
    await expect(applicationClipboardReadiness(adapter.configureClipboard, false)).resolves.toBe(
      undefined,
    );
    expect(policy).not.toHaveBeenCalled();
    expect(adapter.copyText("copy me")).toBe(false);
    expect(writeClipboard).not.toHaveBeenCalled();
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

  it("does not mutate a host client when the app is not hosted", async () => {
    const calls: string[][] = [];
    const adapter = createOpenTuiHostLocalTmuxAdapter(false, async (args) => {
      calls.push([...args]);
    });
    expect(adapter.hosted).toBe(false);
    await adapter.putAway();
    expect(calls).toEqual([]);
  });
});
