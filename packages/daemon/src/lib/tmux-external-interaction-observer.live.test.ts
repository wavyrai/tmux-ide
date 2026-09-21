import {
  boundedTmuxInteractionAppendCommand,
  tmuxInteractionOption,
  TMUX_INTERACTION_MAX_DRAIN_BYTES,
} from "./tmux-interaction-retention.ts";
import { createPinnedWorkspaceTmuxAsyncRunner } from "./workspace-pane-creation.ts";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { TmuxExternalInteractionObserver } from "./tmux-external-interaction-observer.ts";
import type { WorkspaceRegistry } from "./workspace-registry.ts";
import { MirrorControlChannel } from "../terminal/mirror/control-channel.ts";

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

describe.skipIf(!hasTmux).sequential("tmux external interaction observer live", () => {
  vi.setConfig({ testTimeout: 20_000 });
  const roots: string[] = [];
  const observers: TmuxExternalInteractionObserver[] = [];

  afterEach(async () => {
    const settled = await Promise.allSettled(
      observers.splice(0).map((observer) => observer.dispose()),
    );
    const failures: unknown[] = settled.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    for (const root of roots.splice(0)) {
      try {
        spawnSync("tmux", ["-S", join(root, "tmux.sock"), "kill-server"], { stdio: "ignore" });
      } finally {
        try {
          rmSync(root, { recursive: true, force: true });
        } catch (error) {
          failures.push(error);
        }
      }
    }
    if (failures.length) throw new AggregateError(failures, "Observer fixture cleanup failed");
  });

  it("publishes ordered markers without a child client and preserves user hooks", async () => {
    const root = mkdtempSync("/tmp/tmux-ide-native-hook-");
    roots.push(root);
    const socketPath = join(root, "tmux.sock");
    const executablePath = realpathSync(
      execFileSync("which", ["tmux"], { encoding: "utf8" }).trim(),
    );
    const run = (args: readonly string[]): string =>
      execFileSync(executablePath, ["-S", socketPath, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    run(["-f", "/dev/null", "new-session", "-d", "-s", "project", "cat"]);
    const pane = run(["display-message", "-p", "-t", "project", "#{pane_id}"]);
    run(["set-option", "-p", "-t", pane, "@tmux_ide_pane_id", "pane.editor"]);
    run(["set-hook", "-ag", "after-send-keys", "display-message user-hook"]);

    const daemonInstanceId = randomUUID();
    const observed: Array<string | null> = [];
    const observer = new TmuxExternalInteractionObserver({
      daemonInstanceId,
      tmuxAuthority: { executablePath, socketSelector: { kind: "path", path: socketPath } },
      registry: {
        list: () => [{ name: "workspace.project", sessionName: "project", projectDir: root }],
      } as unknown as WorkspaceRegistry,
      onObserved: (interaction) => {
        observed.push(interaction.operationId);
        return interaction.operationId !== null;
      },
    });
    observers.push(observer);
    await observer.start();
    const operationIds = Array.from({ length: 32 }, () => randomUUID());
    for (const operationId of operationIds) {
      run([
        "set-option",
        "-p",
        "-t",
        pane,
        "@tmux_ide_send_operation",
        `${daemonInstanceId}:${operationId}`,
        ";",
        "send-keys",
        "-t",
        pane,
        "-l",
        "x",
      ]);
    }
    run(["send-keys", "-t", pane, "-l", "z"]);
    await vi.waitFor(() => expect(observed).toHaveLength(operationIds.length + 1));
    expect(observed).toEqual([...operationIds, null]);

    await observer.dispose();
    expect(run(["show-hooks", "-g", "after-send-keys"])).toContain("user-hook");
    expect(run(["show-hooks", "-g", "after-send-keys"])).not.toContain(daemonInstanceId);
    expect(run(["list-buffers", "-F", "#{buffer_name}"])).not.toContain(daemonInstanceId);
  });

  it("keeps persistent control-mode reply ownership ordered after hooked sends", async () => {
    const root = mkdtempSync("/tmp/tmux-ide-native-hook-control-");
    roots.push(root);
    const socketPath = join(root, "tmux.sock");
    const executablePath = realpathSync(
      execFileSync("which", ["tmux"], { encoding: "utf8" }).trim(),
    );
    const run = (args: readonly string[]): string =>
      execFileSync(executablePath, ["-S", socketPath, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    run(["-f", "/dev/null", "new-session", "-d", "-s", "project", "cat"]);
    const pane = run(["display-message", "-p", "-t", "project", "#{pane_id}"]);
    run(["set-option", "-p", "-t", pane, "@tmux_ide_pane_id", "pane.editor"]);

    const daemonInstanceId = randomUUID();
    const observer = new TmuxExternalInteractionObserver({
      daemonInstanceId,
      tmuxAuthority: { executablePath, socketSelector: { kind: "path", path: socketPath } },
      registry: {
        list: () => [{ name: "workspace.project", sessionName: "project", projectDir: root }],
      } as unknown as WorkspaceRegistry,
      onObserved: () => true,
    });
    observers.push(observer);
    await observer.start();
    const exits: Array<string | null> = [];
    const channel = new MirrorControlChannel({
      executable: executablePath,
      socketPath,
      session: "project",
      handlers: {
        onOutput: () => undefined,
        onNotify: () => undefined,
        onExit: (reason) => exits.push(reason),
      },
    });
    await channel.start();
    try {
      for (let ordinal = 0; ordinal < 16; ordinal += 1) {
        const operationId = randomUUID();
        expect(
          await channel.request(
            `set-option -p -t ${pane} @tmux_ide_send_operation ${daemonInstanceId}:${operationId}`,
          ),
        ).toEqual([]);
        expect(await channel.request(`send-keys -t ${pane} -l x`)).toEqual([]);
        expect(await channel.request(`display-message -p reply-${ordinal}-a`)).toEqual([
          `reply-${ordinal}-a`,
        ]);
        expect(await channel.request(`display-message -p reply-${ordinal}-b`)).toEqual([
          `reply-${ordinal}-b`,
        ]);
      }
      expect(exits).toEqual([]);
    } finally {
      await channel.dispose();
      await observer.dispose();
    }
  });
  it("bounds generated native hooks and NOHOOKS retention through a burst larger than the reader cap", async () => {
    const root = mkdtempSync("/tmp/tmux-ide-hook-overflow-");
    roots.push(root);
    const socketPath = join(root, "tmux.sock");
    const executablePath = realpathSync(
      execFileSync("which", ["tmux"], { encoding: "utf8" }).trim(),
    );
    const run = (args: readonly string[]): string =>
      execFileSync(executablePath, ["-S", socketPath, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    run(["-f", "/dev/null", "new-session", "-d", "-s", "project", "cat"]);
    const pane = run(["display-message", "-p", "-t", "project", "#{pane_id}"]);
    run(["set-option", "-p", "-t", pane, "@tmux_ide_pane_id", "pane.editor"]);
    const authority = {
      executablePath,
      socketSelector: { kind: "path" as const, path: socketPath },
    };
    const pinnedRead = createPinnedWorkspaceTmuxAsyncRunner(authority);
    // Deterministic old failure mechanism using the real production 64 KiB reader.
    const legacy = join(root, "legacy-data");
    writeFileSync(legacy, "x".repeat(70_000));
    run(["load-buffer", "-b", "legacy-overflow", legacy]);
    await expect(pinnedRead(["show-buffer", "-b", "legacy-overflow"])).rejects.toThrow(
      /maxBuffer/u,
    );
    run(["delete-buffer", "-b", "legacy-overflow"]);
    const daemonInstanceId = randomUUID();
    const gaps: string[] = [];
    const observed: Array<string | null> = [];
    const observer = new TmuxExternalInteractionObserver({
      daemonInstanceId,
      tmuxAuthority: authority,
      registry: {
        list: () => [{ name: "workspace.project", sessionName: "project", projectDir: root }],
      } as unknown as WorkspaceRegistry,
      onGap: (gap) => gaps.push(gap.reason),
      onObserved: (interaction) => {
        observed.push(interaction.operationId);
        return false;
      },
    });
    // Install without starting the consumer, deliberately accumulating a burst.
    observers.push(observer);
    await observer.install();
    const option = tmuxInteractionOption(
      observer.internalReadHookEmission(pane, "safe-marker-123456").bufferName,
    );
    const script = join(root, "burst.tmux");
    writeFileSync(
      script,
      Array.from({ length: 1_000 }, () => `send-keys -t ${pane} -l x`).join("\n"),
    );
    run(["source-file", script]);
    const last = randomUUID();
    run([
      "set-option",
      "-p",
      "-t",
      pane,
      "@tmux_ide_send_operation",
      `${daemonInstanceId}:${last}`,
      ";",
      "send-keys",
      "-t",
      pane,
      "-l",
      "z",
    ]);
    await vi.waitFor(() => expect(run(["show-options", "-gv", option])).toContain(last));
    const retained = await pinnedRead(["show-options", "-gv", option]);
    expect(Buffer.byteLength(retained)).toBeLessThanOrEqual(TMUX_INTERACTION_MAX_DRAIN_BYTES);
    expect(retained).toContain("|gap|");
    await observer.drain();
    expect(gaps).toEqual(["overflow"]);
    expect(observed.at(-1)).toBe(last);
    expect(observed.length).toBeLessThan(1_001);
    expect(observed.filter(Boolean)).toEqual([last]);
    // Arbitrary and oversized pane option values cannot become command text
    // or force a retained record above its ASCII byte budget.
    for (const marker of ["'; set-option -g @injected yes; '", "界".repeat(1_000)]) {
      run([
        "set-option",
        "-p",
        "-t",
        pane,
        "@tmux_ide_send_operation",
        marker,
        ";",
        "send-keys",
        "-t",
        pane,
        "-l",
        "a",
      ]);
    }
    await vi.waitFor(() =>
      expect(run(["show-options", "-gv", option])).toContain("workspace.pane.send"),
    );
    expect(run(["show-options", "-gqv", "@injected"])).toBe("");
    await observer.drain();
    expect(observed.filter(Boolean)).toEqual([last]);

    // The synchronous recovery writer uses the same production retention command.
    const emission = observer.internalReadHookEmission(pane, "safe-marker-123456");
    writeFileSync(
      script,
      Array.from({ length: 1_000 }, () =>
        boundedTmuxInteractionAppendCommand(emission.bufferName, emission.record),
      ).join("\n"),
    );
    run(["source-file", script]);
    const recoveryRetained = await pinnedRead(["show-options", "-gv", option]);
    expect(Buffer.byteLength(recoveryRetained)).toBeLessThanOrEqual(
      TMUX_INTERACTION_MAX_DRAIN_BYTES,
    );
    expect(recoveryRetained).toContain("|gap|");
    await observer.drain();
    expect(gaps).toEqual(["overflow", "overflow"]);
    // Reconciliation retains this generation's pending data; retirement cleans
    // crashed-generation options through the small ownership buffer index.
    run(["set-buffer", "-b", "tmux-ide-interaction-v3-stale", "retention-owner"]);
    run(["set-option", "-g", "@tmux-ide-interaction-v3-stale", "stale"]);
    run(["set-option", "-g", "@user-option", "preserve"]);
    run(["set-option", "-g", option, "retained-pending"]);
    await observer.install();
    expect(run(["show-options", "-gv", option])).toBe("retained-pending");
    expect(run(["show-options", "-gqv", "@tmux-ide-interaction-v3-stale"])).toBe("");
    expect(run(["show-options", "-gv", "@user-option"])).toBe("preserve");
  });
});
