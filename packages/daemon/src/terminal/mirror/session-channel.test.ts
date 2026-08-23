/**
 * SessionChannel unit tests over a simulated control channel (the real
 * ControlChannelCore fed raw protocol lines — see __tests__/simulated-channel).
 */
import { describe, expect, it, vi } from "vitest";
import {
  SimulatedChannel,
  fixtureAutoReply,
  fixtureState,
  FIXTURE,
  type FixtureState,
} from "./__tests__/simulated-channel.ts";
import type { MirrorLayoutEvent, MirrorPaneEvent } from "./events.ts";
import { PaneFeed } from "./pane-feed.ts";
import { SessionChannel } from "./session-channel.ts";
import type { MirrorFlowRecoveryObservation } from "./session-channel.ts";
import type { MirrorOutputTiming } from "./control-channel.ts";
import type { AtomicPaneSnapshotCollector } from "./control-channel.ts";
import {
  consumeInternalReadOperation,
  registerInternalReadOperation,
} from "../../lib/tmux-interaction-options.ts";

const dec = new TextDecoder();

interface Rig {
  channel: SessionChannel;
  sim: SimulatedChannel;
  state: FixtureState;
  pendingSyncs: Array<() => void>;
  recoveryClock: { nowMs: number };
  pendingRecoveries: Array<{
    callback: () => void;
    delayMs: number;
    dueAtMs: number;
    cancelled: boolean;
  }>;
  manualContinueReply: boolean;
  atomicInvocationAuthorizations: boolean[];
  atomicHookValues: Map<string, string>;
}

async function startedRig(
  options: {
    onNativeClientActivity?: () => void;
    onOutputObserved?: (
      semanticPaneId: string,
      ageMs: number | null,
      timing?: MirrorOutputTiming,
    ) => void;
    onFlowRecoveryObserved?: (observation: MirrorFlowRecoveryObservation) => void;
    continueReply?: "auto-success" | "manual";
    historyLines?: number;
    atomicHook?: boolean;
    replaceAtomicHookBeforeInvoke?: boolean;
  } = {},
): Promise<Rig> {
  const state = fixtureState();
  const pendingSyncs: Array<() => void> = [];
  const recoveryClock = { nowMs: 0 };
  const pendingRecoveries: Rig["pendingRecoveries"] = [];
  let atomicNonceOrdinal = 0;
  const atomicInvocationAuthorizations: boolean[] = [];
  const atomicHookValues = new Map<string, string>();
  let sim: SimulatedChannel | null = null;
  const channel = new SessionChannel({
    session: FIXTURE.session,
    createIo: (handlers) => {
      const autoReply = fixtureAutoReply(state);
      sim = new SimulatedChannel(handlers, (command) => {
        if (options.atomicHook && command.startsWith("set-option -po -t %1 @tmux_ide_atomic_")) {
          const created = /^set-option -po -t %1 (@[^ ]+) (.+)$/u.exec(command);
          if (created) {
            const [, name, value] = created;
            atomicHookValues.set(
              name!,
              options.replaceAtomicHookBeforeInvoke && /^@tmux_ide_atomic_[0-9a-f]+$/u.test(name!)
                ? "replacement-B"
                : value!,
            );
          }
          return [];
        }
        if (options.atomicHook && command.includes("set-hook -Rp -t %1 @tmux_ide_atomic_")) {
          const nonce = /@tmux_ide_atomic_([0-9a-f]{32,128})/u.exec(command)?.[1];
          const authorized =
            nonce !== undefined &&
            atomicHookValues.get(`@tmux_ide_atomic_owner_${nonce}`) === nonce &&
            atomicHookValues.get(`@tmux_ide_atomic_${nonce}`) ===
              atomicHookValues.get(`@tmux_ide_atomic_expected_${nonce}`);
          atomicInvocationAuthorizations.push(authorized);
          return authorized ? [] : [`tmux-ide-atomic-invoke-rejected-v1:${nonce ?? "invalid"}`];
        }
        return options.continueReply === "manual" && command.startsWith("refresh-client")
          ? null
          : autoReply(command);
      });
      if (options.atomicHook) {
        Object.assign(sim, {
          armAtomicPaneSnapshotCollector: (spec: AtomicPaneSnapshotCollector) =>
            sim!.core.armAtomicPaneSnapshotCollector(spec),
          retireAtomicPaneSnapshotCollector: (nonce: string) =>
            sim!.core.retireAtomicPaneSnapshotCollector(nonce),
        });
      }
      return sim;
    },
    generatePaneId: () => "pane.mirror.gen1",
    generateWindowId: () => "window.mirror.gen1",
    historyLines: options.historyLines,
    scheduleSync: (callback) => {
      pendingSyncs.push(callback);
      return () => {};
    },
    scheduleRecovery: (callback, delayMs) => {
      const task = {
        callback,
        delayMs,
        dueAtMs: recoveryClock.nowMs + delayMs,
        cancelled: false,
      };
      pendingRecoveries.push(task);
      return () => {
        task.cancelled = true;
      };
    },
    recoveryNowMs: () => recoveryClock.nowMs,
    ...(options.atomicHook
      ? {
          generateAtomicHookNonce: () => (++atomicNonceOrdinal).toString(16).padStart(32, "0"),
          internalReadHookEmission: (runtimePaneId: string, marker: string) => ({
            bufferName: "owned-buffer",
            signalChannel: "owned-ready",
            record: `${runtimePaneId}|${marker}|workspace.pane.read|`,
          }),
        }
      : {}),
    onNativeClientActivity: options.onNativeClientActivity,
    onOutputObserved: options.onOutputObserved,
    onFlowRecoveryObserved: options.onFlowRecoveryObserved,
  });
  await channel.start();
  await vi.waitFor(() => {
    expect(channel.describe().panes).toHaveLength(3);
  });
  return {
    channel,
    sim: sim!,
    state,
    pendingSyncs,
    recoveryClock,
    pendingRecoveries,
    manualContinueReply: options.continueReply === "manual",
    atomicInvocationAuthorizations,
    atomicHookValues,
  };
}

function runRecoveryTimer(rig: Rig, delayMs = 40): void {
  const task = rig.pendingRecoveries.find(
    (candidate) => !candidate.cancelled && candidate.delayMs === delayMs,
  );
  expect(task, `pending recovery timer ${delayMs}ms`).toBeDefined();
  task!.cancelled = true;
  task!.callback();
}

function advanceRecoveryClock(rig: Rig, durationMs: number): void {
  const target = rig.recoveryClock.nowMs + durationMs;
  for (;;) {
    const task = rig.pendingRecoveries
      .filter((candidate) => !candidate.cancelled && candidate.dueAtMs <= target)
      .sort((left, right) => left.dueAtMs - right.dueAtMs)[0];
    if (!task) break;
    rig.recoveryClock.nowMs = task.dueAtMs;
    task.cancelled = true;
    task.callback();
  }
  rig.recoveryClock.nowMs = target;
}

function completeAtomicRecoveryPhase(
  rig: Rig,
  captureLines: readonly string[],
  cursorLine: string,
  options: {
    status?: boolean;
    complete?: boolean;
    continueNotify?: boolean;
    errorOrdinal?: number;
    guardDelayMs?: number;
  } = {},
): string {
  const install = [...rig.sim.written]
    .reverse()
    .find((command) => command.includes("@tmux_ide_atomic_owner_"));
  expect(install).toBeDefined();
  const nonce = /@tmux_ide_atomic_owner_([0-9a-f]{32,128})/u.exec(install!)?.[1];
  expect(nonce).toBeDefined();
  const hookBody = [...rig.sim.written]
    .reverse()
    .find((command) =>
      command.startsWith(`set-option -po -t %1 @tmux_ide_atomic_expected_${nonce}`),
    );
  const marker = /tmux-ide-internal-read-v2:[0-9a-f-]+/u.exec(hookBody ?? "")?.[0];
  expect(marker).toBeDefined();
  expect(rig.sim.written.at(-1)).toContain(`set-hook -Rp -t %1 @tmux_ide_atomic_${nonce}`);
  // An outer user after-set-hook may run before the seam. It cannot contribute
  // raw snapshot bytes or satisfy any nonce frame.
  rig.sim.feedLines("%begin 1 900 0", "blocking-user-after-set-hook-result", "%end 1 900 0");
  let guardOrdinal = 901;
  const guarded = (...lines: string[]): string[] => {
    const ordinal = guardOrdinal++;
    return [`%begin 1 ${ordinal} 0`, ...lines, `%end 1 ${ordinal} 0`];
  };
  const bodyLines = [
    ...guarded(`%tmux-ide-atomic-v1 ${nonce} start`),
    ...guarded(...captureLines),
    ...guarded(`%tmux-ide-atomic-v1 ${nonce} capture-end`),
    ...guarded(cursorLine),
    ...guarded(`%tmux-ide-atomic-v1 ${nonce} cursor-end`),
    ...guarded(...(options.continueNotify ? ["%continue %1"] : [])),
    ...guarded(),
    ...guarded(),
    ...guarded(),
    ...guarded(),
    ...guarded(...(options.status === false ? [] : [`%tmux-ide-atomic-v1 ${nonce} status-ok`])),
    ...guarded(),
    ...guarded(...(options.complete === false ? [] : [`%tmux-ide-atomic-v1 ${nonce} complete`])),
  ];
  if (options.errorOrdinal !== undefined) {
    const commandNum = 901 + options.errorOrdinal;
    const index = bodyLines.indexOf(`%end 1 ${commandNum} 0`);
    expect(index).toBeGreaterThanOrEqual(0);
    bodyLines[index] = `%error 1 ${commandNum} 0`;
    rig.sim.feedLines(...bodyLines.slice(0, index + 1));
    rig.sim.core.retireAtomicPaneSnapshotCollector(nonce!, "timeout");
    return marker!;
  }
  if (options.guardDelayMs !== undefined) {
    let block: string[] = [];
    let seen = 0;
    for (const line of bodyLines) {
      block.push(line);
      if (!line.startsWith("%end ")) continue;
      if (seen > 0) advanceRecoveryClock(rig, options.guardDelayMs);
      rig.sim.feedLines(...block);
      block = [];
      seen += 1;
    }
    expect(block).toEqual([]);
    return marker!;
  }
  rig.sim.feedLines(...bodyLines);
  return marker!;
}

function acknowledgeContinue(rig: Rig, runtime: string): void {
  rig.sim.feedLines(`%continue ${runtime}`);
}

/** Complete the final ordered continue fence, then its post-reply quiet seam. */
function completeFinalContinueFence(rig: Rig): void {
  if (rig.manualContinueReply) rig.sim.reply([]);
  runRecoveryTimer(rig);
}

function completeRecovery(
  rig: Rig,
  runtime: string,
  _provisionalSeed: string,
  finalSeed: string,
  cursor: string,
): void {
  acknowledgeContinue(rig, runtime);
  rig.sim.reply([finalSeed]);
  rig.sim.reply([cursor]);
  runRecoveryTimer(rig);
  rig.sim.reply([finalSeed]);
  rig.sim.reply([cursor]);
  runRecoveryTimer(rig);
  rig.sim.reply([finalSeed]);
  rig.sim.reply([cursor]);
}

function completeRecoveryConfirmations(rig: Rig, seed: string, cursor: string): void {
  runRecoveryTimer(rig);
  rig.sim.reply([seed]);
  rig.sim.reply([cursor]);
  runRecoveryTimer(rig);
  rig.sim.reply([seed]);
  rig.sim.reply([cursor]);
}

describe("native client activity", () => {
  it("subscribes to attached-client changes and proves native presence from inventory", async () => {
    const onNativeClientActivity = vi.fn();
    const rig = await startedRig({ onNativeClientActivity });
    expect(rig.sim.written).toContain(
      "refresh-client -B 'tmux-ide-native-clients::#{session_attached}'",
    );
    rig.sim.feedLines(`%subscription-changed tmux-ide-native-clients $1 @1 0 %1 : 2`);
    await vi.waitFor(() => {
      expect(
        rig.sim.written.some((command) =>
          command.startsWith(`list-clients -t "${FIXTURE.session}"`),
        ),
      ).toBe(true);
    });
    rig.sim.reply(["0\t123"]);
    await vi.waitFor(() => expect(onNativeClientActivity).toHaveBeenCalledTimes(1));
    await rig.channel.dispose();
  });
});

function collect(): { events: MirrorPaneEvent[]; onEvent: (e: MirrorPaneEvent) => void } {
  const events: MirrorPaneEvent[] = [];
  return { events, onEvent: (event) => events.push(event) };
}

function bytesOf(events: readonly MirrorPaneEvent[]): string[] {
  return events
    .filter((event) => event.type === "seed" || event.type === "delta")
    .map((event) => dec.decode((event as { data: Uint8Array }).data));
}

function continueNotificationQueueSize(channel: SessionChannel): number {
  return (
    channel as unknown as {
      continueNotificationQueues: ReadonlyMap<string, readonly unknown[]>;
    }
  ).continueNotificationQueues.size;
}

describe("identity join", () => {
  it("strictly recovers the retained control client's Unicode session identity", async () => {
    const session = "zz-café-😀";
    const state = fixtureState();
    state.descriptorRows = state.descriptorRows.map((row) =>
      Buffer.from(row.replace("\tzz-sim\t", `\t"${session}"\t`), "utf8").toString("latin1"),
    );
    let sim: SimulatedChannel | null = null;
    const channel = new SessionChannel({
      session,
      createIo: (handlers) => {
        const baseReply = fixtureAutoReply(state);
        sim = new SimulatedChannel(handlers, (command) =>
          command.startsWith('display-message -p "#{qa:session_name}')
            ? [Buffer.from(`"${session}"\t$1`, "utf8").toString("latin1")]
            : baseReply(command),
        );
        return sim;
      },
      generatePaneId: () => "pane.mirror.gen1",
    });
    await channel.start();
    await expect(channel.attachedSessionIdentity()).resolves.toEqual({
      sessionName: session,
      runtimeSessionId: "$1",
    });
    await channel.dispose();
  });

  it("verifies stamps, generates+stamps back the unstamped pane, and never leaks runtime ids", async () => {
    const { channel, sim } = await startedRig();
    const description = channel.describe();
    const ids = description.panes.map((pane) => pane.semanticPaneId).sort();
    expect(ids).toEqual(["pane.alpha", "pane.beta", "pane.mirror.gen1"]);
    expect(
      sim.written.some((cmd) =>
        cmd.startsWith('set-option -p -t %3 @tmux_ide_pane_id "pane.mirror.gen1"'),
      ),
    ).toBe(true);
    // Semantic window join rides the same description.
    const gamma = description.panes.find((pane) => pane.semanticPaneId === "pane.mirror.gen1")!;
    expect(gamma.semanticWindowId).toBe("window.test.two");
    // Runtime addresses stay inside the boundary.
    expect(JSON.stringify(description)).not.toMatch(/%[0-9]/);
    await channel.dispose();
  });

  it("projects one coherent refreshed trusted inventory and keeps raw ids daemon-private", async () => {
    const { channel, sim, state } = await startedRig();
    state.descriptorRows[2] = state.descriptorRows[2]!.replace(
      "%3\t\t",
      "%3\tpane.mirror.gen1\t",
    ).replace("\t\tzz-sim", "\twindow.test.two\tzz-sim");
    const beforeQueries = sim.written.filter((command) =>
      command.includes("qa:@tmux_ide_pane_id"),
    ).length;

    const trusted = await channel.describeTrustedInventory("$1");

    expect(trusted).toMatchObject({ sessionName: FIXTURE.session, runtimeSessionId: "$1" });
    expect(trusted.panes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runtimePaneId: "%1",
          semanticPaneId: "pane.alpha",
          semanticWindowId: "window.test.one",
          windowPaneCount: 2,
          sessionWindowCount: 2,
          active: true,
          paneIndex: 0,
          missionStamp: "mission-a",
        }),
      ]),
    );
    expect(
      sim.written.filter((command) => command.includes("qa:@tmux_ide_pane_id")).length -
        beforeQueries,
    ).toBe(2);
    expect(JSON.stringify(channel.describe())).not.toMatch(/[%@$][0-9]/u);
    await channel.dispose();
  });

  it("fails trusted inventory closed when the coherent fence has no single active pane", async () => {
    const { channel, state } = await startedRig();
    state.descriptorRows[2] = state.descriptorRows[2]!.replace(
      "%3\t\t",
      "%3\tpane.mirror.gen1\t",
    ).replace("\t\tzz-sim", "\twindow.test.two\tzz-sim");
    state.descriptorRows[1] = state.descriptorRows[1]!.replace("\t0\t1\twindow", "\t1\t1\twindow");
    await expect(channel.describeTrustedInventory("$1")).rejects.toThrow("inconsistent");
    await channel.dispose();
  });

  it("rejects a same-name runtime-id mismatch before identity mutation", async () => {
    const { channel, sim, state } = await startedRig();
    state.descriptorRows[2] = state.descriptorRows[2]!.replace(
      "%3\t\t",
      "%3\tpane.mirror.gen1\t",
    ).replace("\t\tzz-sim", "\twindow.test.two\tzz-sim");
    const mutationsBefore = sim.written.filter((command) =>
      command.startsWith("set-option"),
    ).length;
    await expect(channel.describeTrustedInventory("$9")).rejects.toThrow("inconsistent");
    expect(sim.written.filter((command) => command.startsWith("set-option"))).toHaveLength(
      mutationsBefore,
    );
    await channel.dispose();
  });

  it("rejects a truncated descriptor reply whose self-reported counts do not close", async () => {
    const { channel, state } = await startedRig();
    state.descriptorRows.splice(1, 1);
    await expect(channel.describeTrustedInventory("$1")).rejects.toThrow("incomplete counts");
    await channel.dispose();
  });

  it("refreshes topology and global active truth on every trusted read", async () => {
    const { channel, state } = await startedRig();
    state.descriptorRows[2] = state.descriptorRows[2]!.replace(
      "%3\t\t",
      "%3\tpane.mirror.gen1\t",
    ).replace("\t\tzz-sim", "\twindow.test.two\tzz-sim");
    await channel.describeTrustedInventory("$1");

    state.descriptorRows.splice(2, 1);
    state.windowRows.splice(1, 1);
    state.descriptorRows = state.descriptorRows.map((row, index) => {
      const fields = row.split("\t");
      fields[14] = index === 1 ? "1" : "0";
      fields[15] = "1";
      fields[18] = "2";
      fields[19] = "1";
      return fields.join("\t");
    });

    const refreshed = await channel.describeTrustedInventory("$1");
    expect(refreshed.panes).toHaveLength(2);
    expect(refreshed.panes.find((pane) => pane.active)?.semanticPaneId).toBe("pane.beta");
    await channel.dispose();
  });

  it("requires a byte-stable post-repair reread before publishing inventory", async () => {
    const state = fixtureState();
    let sim: SimulatedChannel | null = null;
    const channel = new SessionChannel({
      session: FIXTURE.session,
      createIo: (handlers) => {
        const baseReply = fixtureAutoReply(state);
        sim = new SimulatedChannel(handlers, (command) => {
          if (command.startsWith("set-option -p -t %3")) {
            state.descriptorRows[2] = state.descriptorRows[2]!.replace(
              "%3\t\t",
              "%3\tpane.mirror.gen1\t",
            );
          }
          return baseReply(command);
        });
        return sim;
      },
      generatePaneId: () => "pane.mirror.gen1",
    });
    await channel.start();
    state.descriptorRows[2] = state.descriptorRows[2]!.replace(
      "%3\tpane.mirror.gen1\t",
      "%3\t\t",
    ).replace("\t\tzz-sim", "\twindow.test.two\tzz-sim");
    const before = sim!.written.filter((command) =>
      command.includes("qa:@tmux_ide_pane_id"),
    ).length;

    await expect(channel.describeTrustedInventory("$1")).resolves.toMatchObject({
      panes: expect.any(Array),
    });
    expect(
      sim!.written.filter((command) => command.includes("qa:@tmux_ide_pane_id")).length - before,
    ).toBe(4);
    await channel.dispose();
  });

  it("keeps a generated identity unpublished when its stamp-back fails", async () => {
    const state = fixtureState();
    let sim: SimulatedChannel | null = null;
    const channel = new SessionChannel({
      session: FIXTURE.session,
      createIo: (handlers) => {
        sim = new SimulatedChannel(handlers, (cmd) => {
          if (cmd.startsWith("set-option -p")) return null; // manual: fail it
          return fixtureAutoReply(state)(cmd);
        });
        return sim;
      },
      generatePaneId: () => "pane.mirror.gen1",
    });
    const started = channel.start();
    await vi.waitFor(() => {
      expect(sim!.written.some((cmd) => cmd.startsWith("set-option -p"))).toBe(true);
    });
    sim!.reply(["no such option"], false);
    await started;
    await vi.waitFor(() => {
      expect(channel.describe().panes).toHaveLength(2);
    });
    const description = channel.describe();
    expect(description.degraded).toBe(true);
    expect(description.diagnostics.some((diag) => diag.code === "SEMANTIC_STAMP_BACK_FAILED")).toBe(
      true,
    );
    await channel.dispose();
  });
});

describe("seed recipe (the FIFO seam)", () => {
  it("discards pre-reply output, holds the probe window, and emits one atomic batch", async () => {
    const { channel, sim } = await startedRig();
    const alpha = collect();
    channel.subscribePane("pane.alpha", alpha.onEvent);
    // The two probes left back-to-back.
    const capture = sim.written.filter((cmd) => cmd.includes("capture-pane"));
    expect(capture).toHaveLength(1);
    expect(capture[0]).toContain("-t %1");
    expect(sim.written.some((cmd) => cmd.startsWith("display-message -p -t %1"))).toBe(true);

    sim.output("%1", "PRE"); // produced before the capture instant → in the capture
    expect(alpha.events).toHaveLength(0);
    sim.reply(["CAPTURED:PRE"]); // the capture reply lands (FIFO seam)
    sim.output("%1", "MID"); // strictly-after-capture, probe window → held
    sim.reply(["4 9 100 50"]); // the cursor probe reply → atomic batch
    expect(alpha.events.map((event) => event.type)).toEqual(["reset", "seed", "delta", "cursor"]);
    expect(alpha.events[0]).toEqual({ type: "reset", cols: 100, rows: 50 });
    expect(bytesOf(alpha.events)).toEqual(["CAPTURED:PRE", "MID"]);
    expect(alpha.events[3]).toEqual({ type: "cursor", x: 4, y: 9 });

    sim.output("%1", "POST");
    expect(bytesOf(alpha.events).at(-1)).toBe("POST");
    await channel.dispose();
  });

  it("routes bytes only to the pane's own subscribers", async () => {
    const { channel, sim } = await startedRig();
    const alpha = collect();
    const beta = collect();
    channel.subscribePane("pane.alpha", alpha.onEvent);
    sim.reply(["seed-a"]);
    sim.reply(["0 0 100 50"]);
    channel.subscribePane("pane.beta", beta.onEvent);
    sim.reply(["seed-b"]);
    sim.reply(["0 0 99 50"]);

    sim.output("%1", "FOR-ALPHA");
    sim.output("%2", "FOR-BETA");
    expect(bytesOf(alpha.events)).toEqual(["seed-a", "FOR-ALPHA"]);
    expect(bytesOf(beta.events)).toEqual(["seed-b", "FOR-BETA"]);
    await channel.dispose();
  });
});

describe("flow control", () => {
  async function seededPair(rig: Rig): Promise<{
    alpha: ReturnType<typeof collect>;
    beta: ReturnType<typeof collect>;
  }> {
    const alpha = collect();
    const beta = collect();
    rig.channel.subscribePane("pane.alpha", alpha.onEvent);
    rig.sim.reply(["seed-a"]);
    rig.sim.reply(["0 0 100 50"]);
    rig.channel.subscribePane("pane.beta", beta.onEvent);
    rig.sim.reply(["seed-b"]);
    rig.sim.reply(["0 0 99 50"]);
    alpha.events.length = 0;
    beta.events.length = 0;
    return { alpha, beta };
  }

  it("recovers EVERY backpressure-paused pane on any recovery (sticky %pause)", async () => {
    const rig = await startedRig();
    const { alpha, beta } = await seededPair(rig);

    // The stall paused the flooding pane AND the quiet sibling (measured
    // sticky behavior). Feed both pauses in one chunk, then answer the
    // recovery reseeds in FIFO order.
    rig.sim.feedLines("%pause %1");
    expect(rig.sim.written.filter((cmd) => cmd === "refresh-client -A '%1:continue'")).toHaveLength(
      1,
    );
    completeRecovery(rig, "%1", "provisional-a", "reseed-a", "0 0 100 50");
    rig.sim.feedLines("%pause %2");
    expect(rig.sim.written.filter((cmd) => cmd === "refresh-client -A '%2:continue'")).toHaveLength(
      1,
    );
    completeRecovery(rig, "%2", "provisional-b", "reseed-b", "0 0 99 50");

    expect(alpha.events.map((event) => event.type)).toEqual([
      "flow",
      "reset",
      "seed",
      "cursor",
      "flow",
    ]);
    expect(alpha.events[0]).toEqual({ type: "flow", state: "paused", reason: "backpressure" });
    expect(alpha.events.at(-1)).toEqual({
      type: "flow",
      state: "resumed",
      reason: "backpressure",
    });
    expect(bytesOf(beta.events)).toEqual(["reseed-b"]);
    expect(rig.channel.flowSnapshot()).toEqual({ backpressured: [], requested: [] });
    await rig.channel.dispose();
  });

  it("leaves a pane paused when nobody unfrozen is watching, and recovers it on subscribe", async () => {
    const rig = await startedRig();
    rig.sim.feedLines("%pause %1"); // no subscribers at all
    expect(rig.sim.written.some((cmd) => cmd.includes("%1:continue"))).toBe(false);

    const alpha = collect();
    rig.channel.subscribePane("pane.alpha", alpha.onEvent);
    expect(rig.sim.written.some((cmd) => cmd === "refresh-client -A '%1:continue'")).toBe(true);
    completeRecovery(rig, "%1", "late-provisional", "late-seed", "0 0 100 50");
    expect(bytesOf(alpha.events)).toEqual(["late-seed"]);
    await rig.channel.dispose();
  });

  it("freezes one pane without touching siblings, and thaws with continue+reseed", async () => {
    const rig = await startedRig();
    const alpha = collect();
    const beta = collect();
    rig.channel.subscribePane("pane.alpha", alpha.onEvent);
    rig.sim.reply(["seed-a"]);
    rig.sim.reply(["0 0 100 50"]);
    const betaHandle = rig.channel.subscribePane("pane.beta", beta.onEvent);
    rig.sim.reply(["seed-b"]);
    rig.sim.reply(["0 0 99 50"]);
    alpha.events.length = 0;
    beta.events.length = 0;

    // beta briefly has TWO subscribers; freezing one must not park the pane.
    const betaHandle2 = rig.channel.subscribePane("pane.beta", () => {});
    rig.sim.reply(["z"]);
    rig.sim.reply(["0 0 99 50"]);
    betaHandle2.freeze();
    expect(rig.sim.written.some((cmd) => cmd.includes("%2:pause"))).toBe(false);
    betaHandle2.close();

    betaHandle.freeze();
    expect(rig.sim.written.some((cmd) => cmd === "refresh-client -A '%2:pause'")).toBe(true);
    expect(rig.channel.flowSnapshot().requested).toEqual(["pane.beta"]);
    rig.sim.output("%2", "WHILE-FROZEN");
    expect(bytesOf(beta.events)).toEqual([]); // frozen: nothing delivered

    // Sibling alpha keeps flowing the whole time.
    rig.sim.output("%1", "SIBLING");
    expect(bytesOf(alpha.events)).toEqual(["SIBLING"]);

    betaHandle.thaw();
    expect(rig.sim.written.some((cmd) => cmd === "refresh-client -A '%2:continue'")).toBe(true);
    completeRecovery(rig, "%2", "thawed-provisional", "thawed-seed", "0 0 99 50");
    const flows = beta.events.filter((event) => event.type === "flow");
    expect(flows).toEqual([
      { type: "flow", state: "paused", reason: "requested" },
      { type: "flow", state: "resumed", reason: "requested" },
    ]);
    expect(bytesOf(beta.events)).toEqual(["thawed-seed"]);
    await rig.channel.dispose();
  });

  it("returns the pause ticket when a frozen pane's last subscriber departs", async () => {
    const rig = await startedRig();
    const alpha = collect();
    const handle = rig.channel.subscribePane("pane.alpha", alpha.onEvent);
    rig.sim.reply(["s"]);
    rig.sim.reply(["0 0 100 50"]);
    handle.freeze();
    expect(rig.sim.written.some((cmd) => cmd === "refresh-client -A '%1:pause'")).toBe(true);
    handle.close();
    expect(rig.sim.written.some((cmd) => cmd === "refresh-client -A '%1:continue'")).toBe(true);
    expect(rig.channel.flowSnapshot()).toEqual({ backpressured: [], requested: [] });
    await rig.channel.dispose();
  });

  it("repaints once after resumed output becomes quiet without another output notification", async () => {
    const phases: string[] = [];
    const rig = await startedRig({
      onFlowRecoveryObserved: (observation) => phases.push(observation.phase),
    });
    const alpha = collect();
    rig.channel.subscribePane("pane.alpha", alpha.onEvent);
    rig.sim.reply(["seed"]);
    rig.sim.reply(["0 0 100 50"]);
    alpha.events.length = 0;

    rig.sim.feedLines("%pause %1", "%continue %1");
    rig.sim.reply(["INTERMEDIATE"]);
    rig.sim.reply(["0 40 100 50"]);
    rig.sim.output("%1", "FINAL-BYTES");
    runRecoveryTimer(rig);
    rig.sim.reply(["FINAL-CAPTURE"]);
    rig.sim.reply(["0 39 100 50"]);
    completeRecoveryConfirmations(rig, "FINAL-CAPTURE", "0 39 100 50");

    expect(bytesOf(alpha.events)).toEqual(["FINAL-CAPTURE"]);
    expect(alpha.events.filter((event) => event.type === "flow")).toEqual([
      { type: "flow", state: "paused", reason: "backpressure" },
      { type: "flow", state: "resumed", reason: "backpressure" },
    ]);
    expect(phases).toEqual([
      "pause",
      "continue-request",
      "continue-notify",
      "continue-reply",
      "final-reseed",
      "final-reseed",
      "confirmation-reseed",
      "confirmation-reseed",
      "converged",
    ]);
    await rig.channel.dispose();
  });

  it("converges from a successful continue reply when tmux emits no continue notification", async () => {
    const observations: MirrorFlowRecoveryObservation[] = [];
    const rig = await startedRig({
      continueReply: "manual",
      onFlowRecoveryObserved: (observation) => observations.push(observation),
    });
    const alpha = collect();
    rig.channel.subscribePane("pane.alpha", alpha.onEvent);
    rig.sim.reply(["seed"]);
    rig.sim.reply(["0 0 100 50"]);
    alpha.events.length = 0;

    rig.sim.feedLines("%pause %1");
    rig.sim.reply([]); // successful ordered refresh-client reply; no %continue follows
    rig.sim.reply(["INTERMEDIATE"]);
    rig.sim.reply(["0 40 100 50"]);
    for (let ordinal = 0; ordinal < 64; ordinal += 1) rig.sim.output("%1", `load-${ordinal}\n`);
    rig.sim.output("%1", "WORKLOAD-MARKER\n");
    completeFinalContinueFence(rig);
    rig.sim.reply([`${"F".repeat(876_400)}WORKLOAD-MARKER`]);
    rig.sim.reply(["38 39 100 50"]);
    completeRecoveryConfirmations(rig, `${"F".repeat(876_400)}WORKLOAD-MARKER`, "38 39 100 50");

    expect(observations.map(({ phase }) => phase)).toEqual([
      "pause",
      "continue-request",
      "continue-reply",
      "final-reseed",
      "final-reseed",
      "confirmation-reseed",
      "confirmation-reseed",
      "converged",
    ]);
    expect(bytesOf(alpha.events).join("").split("WORKLOAD-MARKER")).toHaveLength(2);
    expect(alpha.events.filter((event) => event.type === "flow")).toEqual([
      { type: "flow", state: "paused", reason: "backpressure" },
      { type: "flow", state: "resumed", reason: "backpressure" },
    ]);
    expect(rig.channel.flowSnapshot()).toEqual({ backpressured: [], requested: [] });
    await rig.channel.dispose();
  });

  it("uses one NOHOOKS raw pane seam per private phase and publishes only confirm2", async () => {
    const observations: MirrorFlowRecoveryObservation[] = [];
    const rig = await startedRig({
      atomicHook: true,
      onFlowRecoveryObserved: (observation) => observations.push(observation),
    });
    const alpha = collect();
    rig.channel.subscribePane("pane.alpha", alpha.onEvent);
    rig.sim.reply(["initial"]);
    rig.sim.reply(["0 0 100 50"]);
    alpha.events.length = 0;

    rig.sim.feedLines("%pause %1");
    completeAtomicRecoveryPhase(rig, ["POST-SEAM-AUTHORITY"], "38 39 100 50 0 1 0 0 0 0 0 0 0 1");
    expect(bytesOf(alpha.events)).toEqual([]);
    runRecoveryTimer(rig);
    completeAtomicRecoveryPhase(rig, ["POST-SEAM-AUTHORITY"], "38 39 100 50 0 1 0 0 0 0 0 0 0 1");
    expect(bytesOf(alpha.events)).toEqual([]);
    runRecoveryTimer(rig);
    completeAtomicRecoveryPhase(rig, ["POST-SEAM-AUTHORITY"], "38 39 100 50 0 1 0 0 0 0 0 0 0 1");

    expect(bytesOf(alpha.events)).toEqual(["POST-SEAM-AUTHORITY"]);
    expect(observations.at(-1)?.phase).toBe("converged");
    const hookBodies = rig.sim.written.filter((command) =>
      command.startsWith("set-option -po -t %1 @tmux_ide_atomic_expected_"),
    );
    expect(hookBodies).toHaveLength(3);
    for (const command of hookBodies) {
      expect(command).toContain("capture-pane -p -e -J");
      expect(command).toContain("display-message -p -t %1");
      expect(command).toContain("refresh-client -A %1:continue");
      expect(command).toContain("set-buffer -a -b owned-buffer");
      expect(command).toContain("wait-for -S owned-ready");
      expect(command).not.toContain("run-shell");
    }
    const invocations = rig.sim.written.filter(
      (command) => command.startsWith("if-shell -t %1 -F") && command.includes("set-hook -Rp"),
    );
    expect(invocations).toHaveLength(3);
    expect(rig.atomicInvocationAuthorizations).toEqual([true, true, true]);
    for (const command of invocations) {
      expect(command).toMatch(
        /#\{&&:#\{==:#\{@tmux_ide_atomic_owner_[0-9a-f]+\},[0-9a-f]+\},#\{==:#\{@tmux_ide_atomic_[0-9a-f]+\},#\{@tmux_ide_atomic_expected_[0-9a-f]+\}\}\}/u,
      );
    }
    await rig.channel.dispose();
  });

  it("keeps a >3s 5k-row atomic candidate alive through authenticated collector progress", async () => {
    const observations: MirrorFlowRecoveryObservation[] = [];
    const rig = await startedRig({
      atomicHook: true,
      historyLines: 5_000,
      onFlowRecoveryObserved: (observation) => observations.push(observation),
    });
    const alpha = collect();
    rig.channel.subscribePane("pane.alpha", alpha.onEvent);
    rig.sim.reply(["initial"]);
    rig.sim.reply(["0 0 100 50"]);
    alpha.events.length = 0;
    const authority = Array.from(
      { length: 5_000 },
      (_, index) => `${index.toString().padStart(4, "0")}:${"A".repeat(150)}`,
    );

    rig.sim.feedLines("%pause %1");
    completeAtomicRecoveryPhase(rig, authority, "38 39 100 50 0 1 0 0 0 0 0 0 0 1", {
      guardDelayMs: 260,
    });
    expect(rig.recoveryClock.nowMs).toBeGreaterThan(3_000);
    expect(observations.some(({ phase }) => phase === "nonconverged")).toBe(false);
    runRecoveryTimer(rig);
    completeAtomicRecoveryPhase(rig, authority, "38 39 100 50 0 1 0 0 0 0 0 0 0 1");
    runRecoveryTimer(rig);
    completeAtomicRecoveryPhase(rig, authority, "38 39 100 50 0 1 0 0 0 0 0 0 0 1");

    expect(observations.at(-1)).toMatchObject({
      phase: "converged",
      collectorStarted: true,
      collectorLastCompletedOrdinal: 12,
      collectorCaptureLineCount: 5_000,
      collectorStatusObserved: true,
      collectorObserverEmissionObserved: true,
      collectorFailureReason: null,
    });
    expect(bytesOf(alpha.events)).toHaveLength(1);
    expect(rig.recoveryClock.nowMs).toBeLessThan(5_000);
    await rig.channel.dispose();
  });

  it("retires an armed atomic collector immediately when all participants freeze", async () => {
    const rig = await startedRig({ atomicHook: true });
    const alpha = collect();
    const handle = rig.channel.subscribePane("pane.alpha", alpha.onEvent);
    rig.sim.reply(["initial"]);
    rig.sim.reply(["0 0 100 50"]);
    alpha.events.length = 0;

    rig.sim.feedLines("%pause %1");
    handle.freeze();
    const settled = vi.fn();
    expect(
      rig.sim.core.armAtomicPaneSnapshotCollector({
        nonce: "f".repeat(32),
        runtimePaneId: "%1",
        maxCaptureBytes: 1024,
        maxCaptureLines: 16,
        maxCursorBytes: 256,
        observerCommandCount: 2,
        onSettled: settled,
      }),
    ).toBe(true);
    rig.sim.core.retireAtomicPaneSnapshotCollector("f".repeat(32));
    expect(settled).toHaveBeenCalledOnce();
    expect(bytesOf(alpha.events)).toEqual([]);
    await rig.channel.dispose();
  });

  it("retires the exact collector on a silent 3s gap and does not rearm for foreign framing", async () => {
    const observations: MirrorFlowRecoveryObservation[] = [];
    const rig = await startedRig({
      atomicHook: true,
      onFlowRecoveryObserved: (observation) => observations.push(observation),
    });
    const alpha = collect();
    rig.channel.subscribePane("pane.alpha", alpha.onEvent);
    rig.sim.reply(["initial"]);
    rig.sim.reply(["0 0 100 50"]);
    alpha.events.length = 0;

    rig.sim.feedLines("%pause %1");
    const install = [...rig.sim.written]
      .reverse()
      .find((command) => command.includes("@tmux_ide_atomic_owner_"))!;
    const nonceMatch = /@tmux_ide_atomic_owner_([0-9a-f]{32,128})/u.exec(install);
    expect(nonceMatch).not.toBeNull();
    const nonce = nonceMatch![1]!;
    rig.sim.feedLines("%begin 1 901 0", `%tmux-ide-atomic-v1 ${nonce} start`, "%end 1 901 0");
    advanceRecoveryClock(rig, 2_999);
    rig.sim.feedLines(`%tmux-ide-atomic-v1 ${"f".repeat(32)} capture-end`);
    advanceRecoveryClock(rig, 1);

    expect(observations.at(-1)).toMatchObject({
      phase: "nonconverged",
      failureReason: "no-progress",
      collectorStarted: true,
      collectorLastCompletedOrdinal: 0,
      collectorFailureReason: "foreign-sentinel",
    });
    expect(bytesOf(alpha.events)).toEqual([]);
    const replacement = vi.fn();
    expect(
      rig.sim.core.armAtomicPaneSnapshotCollector({
        nonce: "e".repeat(32),
        runtimePaneId: "%1",
        maxCaptureBytes: 1024,
        maxCaptureLines: 16,
        maxCursorBytes: 256,
        observerCommandCount: 2,
        onSettled: replacement,
      }),
    ).toBe(true);
    rig.sim.core.retireAtomicPaneSnapshotCollector("e".repeat(32));
    await rig.channel.dispose();
  });

  it("seals only the current stalled collector after an earlier candidate succeeded", async () => {
    const observations: MirrorFlowRecoveryObservation[] = [];
    const rig = await startedRig({
      atomicHook: true,
      onFlowRecoveryObserved: (observation) => observations.push(observation),
    });
    const alpha = collect();
    rig.channel.subscribePane("pane.alpha", alpha.onEvent);
    rig.sim.reply(["initial"]);
    rig.sim.reply(["0 0 100 50"]);
    alpha.events.length = 0;

    rig.sim.feedLines("%pause %1");
    completeAtomicRecoveryPhase(rig, ["PRIVATE-CANDIDATE"], "38 39 100 50 0 1 0 0 0 0 0 0 0 1");
    expect(observations.at(-1)).toMatchObject({
      phase: "final-reseed",
      collectorLastCompletedOrdinal: 12,
      collectorStatusObserved: true,
      collectorObserverEmissionObserved: true,
    });
    runRecoveryTimer(rig);
    const install = [...rig.sim.written]
      .reverse()
      .find((command) => command.includes("@tmux_ide_atomic_owner_"))!;
    const nonceMatch = /@tmux_ide_atomic_owner_([0-9a-f]{32,128})/u.exec(install);
    expect(nonceMatch).not.toBeNull();
    const nonce = nonceMatch![1]!;
    rig.sim.feedLines("%begin 1 901 0", `%tmux-ide-atomic-v1 ${nonce} start`, "%end 1 901 0");
    advanceRecoveryClock(rig, 3_000);

    expect(observations.at(-1)).toMatchObject({
      phase: "nonconverged",
      failureReason: "no-progress",
      collectorStarted: true,
      collectorLastCompletedOrdinal: 0,
      collectorCaptureLineCount: 0,
      collectorCaptureByteCount: 0,
      collectorContinueObserved: false,
      collectorStatusObserved: false,
      collectorObserverEmissionObserved: false,
      collectorFailureReason: "retired",
    });
    expect(bytesOf(alpha.events)).toEqual([]);
    await rig.channel.dispose();
  });

  it("does not execute or unset a hook body replaced after create and before invoke", async () => {
    const rig = await startedRig({ atomicHook: true, replaceAtomicHookBeforeInvoke: true });
    const alpha = collect();
    const handle = rig.channel.subscribePane("pane.alpha", alpha.onEvent);
    rig.sim.reply(["initial"]);
    rig.sim.reply(["0 0 100 50"]);
    alpha.events.length = 0;

    rig.sim.feedLines("%pause %1");
    expect(rig.atomicInvocationAuthorizations).toEqual([false]);
    const replacement = [...rig.atomicHookValues.entries()].find(([name]) =>
      /^@tmux_ide_atomic_[0-9a-f]+$/u.test(name),
    );
    expect(replacement?.[1]).toBe("replacement-B");
    expect(bytesOf(alpha.events)).toEqual([]);

    handle.freeze();
    expect(replacement?.[1]).toBe("replacement-B");
    expect(bytesOf(alpha.events)).toEqual([]);
    await rig.channel.dispose();
  });

  it("retires markers before observer emission but preserves a signaled record for one redemption", async () => {
    for (const [errorOrdinal, redeemable] of [
      [7, false],
      [8, true],
      [9, true],
      [10, true],
      [11, true],
      [12, true],
    ] as const) {
      const rig = await startedRig({ atomicHook: true });
      const alpha = collect();
      rig.channel.subscribePane("pane.alpha", alpha.onEvent);
      rig.sim.reply(["initial"]);
      rig.sim.reply(["0 0 100 50"]);
      alpha.events.length = 0;
      rig.sim.feedLines("%pause %1");
      const marker = completeAtomicRecoveryPhase(rig, ["private"], "0 0 100 50", {
        errorOrdinal,
      });
      expect(consumeInternalReadOperation(marker, "%1", "workspace.pane.read")).toBe(redeemable);
      expect(consumeInternalReadOperation(marker, "%1", "workspace.pane.read")).toBe(false);
      expect(bytesOf(alpha.events)).toEqual([]);
      await rig.channel.dispose();
    }
  });

  it("publishes only a confirmed snapshot after the initial ordered continue reply", async () => {
    const observations: MirrorFlowRecoveryObservation[] = [];
    const rig = await startedRig({
      continueReply: "manual",
      onFlowRecoveryObserved: (observation) => observations.push(observation),
    });
    const alpha = collect();
    rig.channel.subscribePane("pane.alpha", alpha.onEvent);
    rig.sim.reply(["initial"]);
    rig.sim.reply(["0 0 100 50"]);
    alpha.events.length = 0;

    rig.sim.feedLines("%pause %1");
    rig.sim.reply([]); // initial liveness continue; no notification
    rig.sim.reply(["PRIVATE-CANDIDATE"]);
    rig.sim.reply(["0 40 100 50"]);
    expect(
      rig.sim.written.filter((command) => command === "refresh-client -A '%1:continue'"),
    ).toHaveLength(1);
    expect(bytesOf(alpha.events)).toEqual([]);

    // Output after the private candidate cannot authorize it or escape quarantine.
    rig.sim.output("%1", "BETWEEN-CANDIDATE-AND-CONFIRM");
    rig.sim.feedLines("%continue %1");
    expect(bytesOf(alpha.events)).toEqual([]);
    runRecoveryTimer(rig);
    rig.sim.reply(["POST-OUTPUT-AUTHORITY"]);
    rig.sim.reply(["38 39 100 50"]);
    completeRecoveryConfirmations(rig, "POST-OUTPUT-AUTHORITY", "38 39 100 50");

    expect(bytesOf(alpha.events)).toEqual(["POST-OUTPUT-AUTHORITY"]);
    expect(observations.filter(({ phase }) => phase === "final-continue-request")).toHaveLength(0);
    expect(observations.filter(({ phase }) => phase === "final-continue-reply")).toHaveLength(0);
    expect(observations.at(-1)?.phase).toBe("converged");
    await rig.channel.dispose();
  });

  it("keeps a failed initial continue command quarantined", async () => {
    const observations: MirrorFlowRecoveryObservation[] = [];
    const rig = await startedRig({
      continueReply: "manual",
      onFlowRecoveryObserved: (observation) => observations.push(observation),
    });
    const alpha = collect();
    rig.channel.subscribePane("pane.alpha", alpha.onEvent);
    rig.sim.reply(["initial"]);
    rig.sim.reply(["0 0 100 50"]);
    alpha.events.length = 0;

    rig.sim.feedLines("%pause %1");
    rig.sim.reply([], false);
    rig.sim.output("%1", "MUST-NOT-LEAK");

    expect(observations.at(-1)).toMatchObject({
      phase: "nonconverged",
      failureReason: "command-error",
    });
    expect(bytesOf(alpha.events)).toEqual([]);
    expect(alpha.events.some((event) => event.type === "flow" && event.state === "resumed")).toBe(
      false,
    );
    expect(continueNotificationQueueSize(rig.channel)).toBe(0);
    await rig.channel.dispose();
  });

  it("applies the exact 500ms hang bound to the initial continue command", async () => {
    const observations: MirrorFlowRecoveryObservation[] = [];
    const rig = await startedRig({
      continueReply: "manual",
      onFlowRecoveryObserved: (observation) => observations.push(observation),
    });
    const alpha = collect();
    rig.channel.subscribePane("pane.alpha", alpha.onEvent);
    rig.sim.reply(["initial"]);
    rig.sim.reply(["0 0 100 50"]);
    alpha.events.length = 0;

    rig.sim.feedLines("%pause %1");
    advanceRecoveryClock(rig, 499);
    expect(observations.some(({ phase }) => phase === "nonconverged")).toBe(false);
    advanceRecoveryClock(rig, 1);
    expect(observations.at(-1)).toMatchObject({
      phase: "nonconverged",
      failureReason: "command-timeout",
      elapsedMicros: 500_000,
    });
    expect(bytesOf(alpha.events)).toEqual([]);
    await rig.channel.dispose();
  });

  it("does not let a late final-fence reply authorize a newer recovery", async () => {
    const observations: MirrorFlowRecoveryObservation[] = [];
    const rig = await startedRig({
      continueReply: "manual",
      onFlowRecoveryObserved: (observation) => observations.push(observation),
    });
    const alpha = collect();
    rig.channel.subscribePane("pane.alpha", alpha.onEvent);
    rig.sim.reply(["initial"]);
    rig.sim.reply(["0 0 100 50"]);
    alpha.events.length = 0;

    rig.sim.feedLines("%pause %1");
    rig.sim.reply([]);
    rig.sim.reply(["OLD-PRIVATE"]);
    rig.sim.reply(["0 40 100 50"]); // old final fence is now in flight
    const oldOrdinal = observations.at(-1)!.recoveryOrdinal;
    rig.sim.feedLines("%pause %1"); // retire old and start a new initial continue
    const newOrdinal = observations.at(-1)!.recoveryOrdinal;
    expect(newOrdinal).not.toBe(oldOrdinal);

    rig.sim.reply([]); // late success for the retired old final fence
    expect(
      observations.some(
        ({ recoveryOrdinal, phase }) =>
          recoveryOrdinal === oldOrdinal && phase === "final-continue-reply",
      ),
    ).toBe(false);
    rig.sim.reply([]); // new initial continue success
    rig.sim.reply(["NEW-PRIVATE"]);
    rig.sim.reply(["0 40 100 50"]);
    completeFinalContinueFence(rig);
    rig.sim.reply(["NEW-AUTHORITY"]);
    rig.sim.reply(["38 39 100 50"]);
    completeRecoveryConfirmations(rig, "NEW-AUTHORITY", "38 39 100 50");

    expect(bytesOf(alpha.events)).toEqual(["NEW-AUTHORITY"]);
    expect(observations.at(-1)).toMatchObject({
      recoveryOrdinal: newOrdinal,
      phase: "converged",
    });
    await rig.channel.dispose();
  });

  it("requires a fresh candidate when exact subscriber membership changes", async () => {
    const observations: MirrorFlowRecoveryObservation[] = [];
    const rig = await startedRig({
      continueReply: "manual",
      onFlowRecoveryObserved: (observation) => observations.push(observation),
    });
    const alpha = collect();
    const sibling = collect();
    rig.channel.subscribePane("pane.alpha", alpha.onEvent);
    rig.sim.reply(["alpha-initial"]);
    rig.sim.reply(["0 0 100 50"]);
    const siblingHandle = rig.channel.subscribePane("pane.alpha", sibling.onEvent);
    rig.sim.reply(["sibling-initial"]);
    rig.sim.reply(["0 0 100 50"]);
    alpha.events.length = 0;
    sibling.events.length = 0;

    rig.sim.feedLines("%pause %1");
    rig.sim.reply([]);
    rig.sim.reply(["PRIVATE-BOTH"]);
    siblingHandle.close();
    rig.sim.reply(["0 40 100 50"]); // stale membership cannot complete this candidate
    expect(bytesOf(alpha.events)).toEqual([]);

    runRecoveryTimer(rig);
    rig.sim.reply(["ALPHA-AUTHORITY"]);
    rig.sim.reply(["38 39 100 50"]);
    completeRecoveryConfirmations(rig, "ALPHA-AUTHORITY", "38 39 100 50");
    expect(bytesOf(alpha.events)).toEqual(["ALPHA-AUTHORITY"]);
    expect(observations.filter(({ phase }) => phase === "final-continue-reply")).toHaveLength(0);
    expect(observations.at(-1)?.phase).toBe("converged");
    await rig.channel.dispose();
  });

  it("lets a source-shaped slow private candidate converge inside the absolute lease", async () => {
    const observations: MirrorFlowRecoveryObservation[] = [];
    const rig = await startedRig({
      continueReply: "manual",
      onFlowRecoveryObserved: (observation) => observations.push(observation),
    });
    const alpha = collect();
    rig.channel.subscribePane("pane.alpha", alpha.onEvent);
    rig.sim.reply(["seed"]);
    rig.sim.reply(["0 0 100 50"]);
    alpha.events.length = 0;

    rig.sim.feedLines("%pause %1");
    rig.sim.reply([]); // ordered continue success starts convergence and cancels 500ms hang timer
    // The private 876KB candidate is delayed by the source-shaped projection
    // interval, but remains inside the unchanged 3s no-progress envelope.
    advanceRecoveryClock(rig, 777);
    advanceRecoveryClock(rig, 1_430);
    expect(observations.at(-1)?.phase).toBe("continue-reply");
    expect(observations.some(({ phase }) => phase === "nonconverged")).toBe(false);

    rig.sim.reply(["WORKLOAD-MARKER"]);
    rig.sim.reply(["38 39 100 50"]);
    advanceRecoveryClock(rig, 40);
    rig.sim.reply(["WORKLOAD-MARKER"]);
    rig.sim.reply(["38 39 100 50"]);
    advanceRecoveryClock(rig, 40);
    rig.sim.reply(["WORKLOAD-MARKER"]);
    rig.sim.reply(["38 39 100 50"]);

    expect(observations.map(({ phase }) => phase)).toEqual([
      "pause",
      "continue-request",
      "continue-reply",
      "final-reseed",
      "confirmation-reseed",
      "confirmation-reseed",
      "converged",
    ]);
    expect(observations.every(({ failureReason }) => failureReason === null)).toBe(true);
    expect(new Set(observations.map(({ outputOrdinal }) => outputOrdinal)).size).toBe(1);
    expect(alpha.events.filter((event) => event.type === "flow")).toEqual([
      { type: "flow", state: "paused", reason: "backpressure" },
      { type: "flow", state: "resumed", reason: "backpressure" },
    ]);
    await rig.channel.dispose();
  });

  it("publishes only the second-confirmed snapshot before costly three-lane fanout", async () => {
    const observations: MirrorFlowRecoveryObservation[] = [];
    const downstream = [collect(), collect(), collect()];
    let publicationCount = 0;
    let recoveryPublicationArmed = false;
    let rig!: Rig;
    rig = await startedRig({
      continueReply: "manual",
      historyLines: 5_000,
      onFlowRecoveryObserved: (observation) => observations.push(observation),
    });
    const upstream = (event: MirrorPaneEvent): void => {
      for (const lane of downstream) lane.onEvent(event);
      if (recoveryPublicationArmed && event.type === "seed") {
        // The real owner fans the seed into three independently settled lanes.
        // Model synchronous publication work whose cost exceeds the remaining
        // recovery lease without allowing the fake scheduler to interrupt the
        // current JavaScript stack. Convergence must retire its queued timers
        // immediately after this one callback returns.
        publicationCount += 1;
        rig.recoveryClock.nowMs += 5_001;
      }
    };
    rig.channel.subscribePane("pane.alpha", upstream); // one physical upstream feed
    rig.sim.reply(["initial"]);
    rig.sim.reply(["0 0 100 50"]);
    for (const lane of downstream) lane.events.length = 0;
    recoveryPublicationArmed = true;

    rig.sim.feedLines("%pause %1");
    rig.sim.reply([]);
    rig.sim.reply(["P".repeat(830_985)]);
    rig.sim.reply(["0 40 100 50"]);
    expect(publicationCount).toBe(0);
    rig.sim.reply([]); // final ordered continue fence
    advanceRecoveryClock(rig, 40);

    // Raw output that lands in the final capture epoch is quarantined. The
    // authoritative capture contains it, so no unconfirmed seed or delta may
    // reach any downstream lane.
    rig.sim.output("%1", "HELD-RAW-DELTA");
    rig.sim.reply(["CONFIRMED-WITH-HELD"]);
    rig.sim.reply(["38 39 100 50"]);
    for (const lane of downstream) expect(bytesOf(lane.events)).toEqual([]);

    advanceRecoveryClock(rig, 40);
    rig.sim.reply(["CONFIRMED-WITH-HELD"]);
    rig.sim.reply(["38 39 100 50"]);
    for (const lane of downstream) expect(bytesOf(lane.events)).toEqual([]);

    advanceRecoveryClock(rig, 40);
    rig.sim.reply(["CONFIRMED-WITH-HELD"]);
    rig.sim.reply(["38 39 100 50"]);

    for (const lane of downstream) {
      expect(bytesOf(lane.events)).toEqual(["CONFIRMED-WITH-HELD"]);
      expect(lane.events.filter((event) => event.type === "flow").at(-1)).toEqual({
        type: "flow",
        state: "resumed",
        reason: "backpressure",
      });
    }
    expect(publicationCount).toBe(1);
    expect(observations.at(-1)?.phase).toBe("converged");

    advanceRecoveryClock(rig, 0);
    expect(observations.some(({ phase }) => phase === "nonconverged")).toBe(false);
    rig.sim.output("%1", "FIFO-AFTER-CONFIRMED");
    for (const lane of downstream) {
      expect(bytesOf(lane.events)).toEqual(["CONFIRMED-WITH-HELD", "FIFO-AFTER-CONFIRMED"]);
    }
    await rig.channel.dispose();
  });

  it("captures one 5k-history authority per recovery phase and fans it to three feeds", async () => {
    const observations: MirrorFlowRecoveryObservation[] = [];
    const rig = await startedRig({
      continueReply: "manual",
      historyLines: 5_000,
      onFlowRecoveryObserved: (observation) => observations.push(observation),
    });
    const subscribers = [collect(), collect(), collect()];
    for (const subscriber of subscribers) {
      rig.channel.subscribePane("pane.alpha", subscriber.onEvent);
      rig.sim.reply(["initial"]);
      rig.sim.reply(["0 0 100 50"]);
      subscriber.events.length = 0;
    }
    const writtenAtRecovery = rig.sim.written.length;
    const candidateLines = Array.from(
      { length: 5_000 },
      (_, index) => `${index.toString().padStart(4, "0")}:${"P".repeat(165)}`,
    );
    const finalLines = candidateLines.with(4_999, `${"F".repeat(160)}WORKLOAD-MARKER`);

    rig.sim.feedLines("%pause %1");
    rig.sim.reply([]);
    advanceRecoveryClock(rig, 777 + 1_430);
    rig.sim.reply(finalLines);
    rig.sim.reply(["38 39 100 50"]);
    advanceRecoveryClock(rig, 40);
    rig.sim.reply(finalLines);
    rig.sim.reply(["38 39 100 50"]);
    advanceRecoveryClock(rig, 40);
    rig.sim.reply(finalLines);
    rig.sim.reply(["38 39 100 50"]);

    const recoveryCommands = rig.sim.written.slice(writtenAtRecovery);
    expect(recoveryCommands.filter((command) => command.includes("capture-pane"))).toHaveLength(3);
    expect(
      recoveryCommands.filter((command) => command.includes("display-message -p")),
    ).toHaveLength(3);
    expect(recoveryCommands.filter((command) => command.includes("capture-pane"))).toEqual(
      expect.arrayContaining([expect.stringContaining("-S -5000")]),
    );
    for (const subscriber of subscribers) {
      const seeds = subscriber.events.filter((event) => event.type === "seed");
      expect(seeds).toHaveLength(1);
      expect(Buffer.from(seeds[0]!.data).includes(Buffer.from("WORKLOAD-MARKER"))).toBe(true);
      expect(subscriber.events.filter((event) => event.type === "flow").at(-1)).toEqual({
        type: "flow",
        state: "resumed",
        reason: "backpressure",
      });
    }
    expect(observations.at(-1)).toMatchObject({
      phase: "converged",
      elapsedMicros: 2_287_000,
      fingerprintExact: true,
    });
    expect(observations.filter(({ phase }) => phase === "confirmation-reseed")).toHaveLength(2);
    await rig.channel.dispose();
  });

  it("aborts a shared recovery phase when its exact subscriber membership changes", async () => {
    const rig = await startedRig({ continueReply: "manual" });
    const subscribers = [collect(), collect(), collect()];
    const handles = subscribers.map((subscriber) => {
      const handle = rig.channel.subscribePane("pane.alpha", subscriber.onEvent);
      rig.sim.reply(["initial"]);
      rig.sim.reply(["0 0 100 50"]);
      subscriber.events.length = 0;
      return handle;
    });

    rig.sim.feedLines("%pause %1");
    rig.sim.reply([]);
    const staleCapture = rig.sim.written.findLast((command) => command.includes("capture-pane"))!;
    const staleMarker = staleCapture.match(/tmux-ide-internal-read-v2:[0-9a-f-]+/u)?.[0];
    expect(staleMarker).toBeDefined();
    handles[2]!.close();
    const siblingMarker = registerInternalReadOperation("%1");
    rig.sim.reply(["must-not-publish"]);
    rig.sim.reply(["0 40 100 50"]);
    for (const subscriber of subscribers)
      expect(subscriber.events.filter((event) => event.type === "seed")).toHaveLength(0);
    expect(consumeInternalReadOperation(staleMarker!, "%1", "workspace.pane.read")).toBe(true);
    expect(consumeInternalReadOperation(staleMarker!, "%1", "workspace.pane.read")).toBe(false);
    expect(consumeInternalReadOperation(siblingMarker, "%1", "workspace.pane.read")).toBe(true);

    completeFinalContinueFence(rig);
    const replacementCapture = rig.sim.written.findLast((command) =>
      command.includes("capture-pane"),
    )!;
    const replacementMarker = replacementCapture.match(
      /tmux-ide-internal-read-v2:[0-9a-f-]+/u,
    )?.[0];
    expect(replacementMarker).toBeDefined();
    expect(replacementMarker).not.toBe(staleMarker);
    expect(
      rig.sim.written.some(
        (command) => command.startsWith("if-shell -t %1 -F") && command.includes(staleMarker!),
      ),
    ).toBe(false);
    expect(
      rig.sim.written.some((command) =>
        command.startsWith(`set-option -pu -t %1 @tmux_ide_read_operation`),
      ),
    ).toBe(false);
    rig.sim.reply(["authoritative"]);
    rig.sim.reply(["0 39 100 50"]);
    completeRecoveryConfirmations(rig, "authoritative", "0 39 100 50");
    for (const subscriber of subscribers.slice(0, 2)) {
      expect(bytesOf(subscriber.events)).toEqual(["authoritative"]);
      expect(subscriber.events.filter((event) => event.type === "flow").at(-1)).toEqual({
        type: "flow",
        state: "resumed",
        reason: "backpressure",
      });
    }
    expect(bytesOf(subscribers[2]!.events)).toEqual([]);
    await rig.channel.dispose();
  });

  it("retires a failed shared capture without clearing a newer read owner", async () => {
    const rig = await startedRig({ continueReply: "manual" });
    const alpha = collect();
    rig.channel.subscribePane("pane.alpha", alpha.onEvent);
    rig.sim.reply(["initial"]);
    rig.sim.reply(["0 0 100 50"]);
    alpha.events.length = 0;

    rig.sim.feedLines("%pause %1");
    rig.sim.reply([]);
    const failedCapture = rig.sim.written.findLast((command) => command.includes("capture-pane"))!;
    const failedMarker = failedCapture.match(/tmux-ide-internal-read-v2:[0-9a-f-]+/u)?.[0];
    expect(failedMarker).toBeDefined();
    const newerMarker = registerInternalReadOperation("%1");
    const foreignMarker = registerInternalReadOperation("%2");
    rig.sim.reply([], false);
    rig.sim.reply([], false);

    expect(consumeInternalReadOperation(failedMarker!, "%1", "workspace.pane.read")).toBe(false);
    expect(consumeInternalReadOperation(newerMarker, "%1", "workspace.pane.read")).toBe(true);
    expect(consumeInternalReadOperation(foreignMarker, "%2", "workspace.pane.read")).toBe(true);
    const cleanup = rig.sim.written.find(
      (command) => command.startsWith("if-shell -t %1 -F") && command.includes(failedMarker!),
    );
    expect(cleanup).toBe(
      `if-shell -t %1 -F "#{==:#{@tmux_ide_read_operation},${failedMarker}}" ` +
        `"set-option -pu -t %1 @tmux_ide_read_operation" ""`,
    );
    expect(
      rig.sim.written.some(
        (command) => command.startsWith("if-shell -t %1 -F") && command.includes(failedMarker!),
      ),
    ).toBe(true);
    expect(
      rig.sim.written.some((command) =>
        command.startsWith(`set-option -pu -t %1 @tmux_ide_read_operation`),
      ),
    ).toBe(false);
    await rig.channel.dispose();
  });

  it("recaptures a late native tail after two stale authoritative snapshots", async () => {
    const observations: MirrorFlowRecoveryObservation[] = [];
    const rig = await startedRig({
      continueReply: "manual",
      onFlowRecoveryObserved: (observation) => observations.push(observation),
    });
    const alpha = collect();
    rig.channel.subscribePane("pane.alpha", alpha.onEvent);
    rig.sim.reply(["seed"]);
    rig.sim.reply(["0 0 100 50"]);
    alpha.events.length = 0;

    const interimProbe = "0 40 100 50 0 0 0 0 0 0 0 0 0 1";
    const finalProbe = "38 39 100 50 0 1 0 0 0 0 0 0 0 1";
    rig.sim.feedLines("%pause %1");
    rig.sim.reply([]);
    // The pane emits no `%output` while the first private candidate is delayed.
    advanceRecoveryClock(rig, 777 + 1_430);
    rig.sim.reply(["INTERIM-Y40-HIDDEN"]);
    rig.sim.reply([interimProbe]);
    advanceRecoveryClock(rig, 40);
    rig.sim.reply(["INTERIM-Y40-HIDDEN"]); // first confirmation is still stale
    rig.sim.reply([interimProbe]);
    expect(alpha.events.some((event) => event.type === "flow" && event.state === "resumed")).toBe(
      false,
    );

    advanceRecoveryClock(rig, 40);
    rig.sim.reply(["WORKLOAD-MARKER"]); // second confirmation observes native truth
    rig.sim.reply([finalProbe]);
    expect(alpha.events.some((event) => event.type === "flow" && event.state === "resumed")).toBe(
      false,
    );
    advanceRecoveryClock(rig, 40);
    rig.sim.reply(["WORKLOAD-MARKER"]);
    rig.sim.reply([finalProbe]);
    advanceRecoveryClock(rig, 40);
    rig.sim.reply(["WORKLOAD-MARKER"]);
    rig.sim.reply([finalProbe]);

    expect(bytesOf(alpha.events)).toEqual(["WORKLOAD-MARKER"]);
    expect(observations.filter(({ phase }) => phase === "confirmation-reseed")).toEqual([
      expect.objectContaining({ fingerprintExact: false, confirmationOrdinal: 1 }),
      expect.objectContaining({ fingerprintExact: false, confirmationOrdinal: 2 }),
      expect.objectContaining({ fingerprintExact: false, confirmationOrdinal: 3 }),
      expect.objectContaining({ fingerprintExact: true, confirmationOrdinal: 4 }),
    ]);
    expect(observations.at(-1)).toMatchObject({
      phase: "converged",
      fingerprintExact: true,
      elapsedMicros: 2_367_000,
    });
    expect(alpha.events.filter((event) => event.type === "flow").at(-1)).toEqual({
      type: "flow",
      state: "resumed",
      reason: "backpressure",
    });
    await rig.channel.dispose();
  });

  it("keeps a failed confirmation capture quarantined and retries authoritatively", async () => {
    const phases: string[] = [];
    const rig = await startedRig({
      onFlowRecoveryObserved: (observation) => phases.push(observation.phase),
    });
    const alpha = collect();
    rig.channel.subscribePane("pane.alpha", alpha.onEvent);
    rig.sim.reply(["seed"]);
    rig.sim.reply(["0 0 100 50"]);
    alpha.events.length = 0;

    rig.sim.feedLines("%pause %1", "%continue %1");
    rig.sim.reply(["provisional"]);
    rig.sim.reply(["0 40 100 50"]);
    completeFinalContinueFence(rig);
    rig.sim.reply(["candidate"]);
    rig.sim.reply(["0 39 100 50"]);
    completeFinalContinueFence(rig);
    rig.sim.reply([], false);
    rig.sim.reply([], false);
    rig.sim.output("%1", "MUST-NOT-LEAK");
    expect(bytesOf(alpha.events)).toEqual([]);
    expect(phases).not.toContain("converged");

    runRecoveryTimer(rig);
    rig.sim.reply(["authoritative"]);
    rig.sim.reply(["0 39 100 50"]);
    completeRecoveryConfirmations(rig, "authoritative", "0 39 100 50");
    expect(bytesOf(alpha.events)).toEqual(["authoritative"]);
    expect(phases.filter((phase) => phase === "final-reseed")).toHaveLength(2);
    expect(phases.at(-1)).toBe("converged");
    expect(
      rig.sim.written.some(
        (command) =>
          command.includes("#{alternate_on}") &&
          command.includes("#{cursor_flag}") &&
          command.includes("#{wrap_flag}"),
      ),
    ).toBe(true);
    await rig.channel.dispose();
  });

  it("bounds authenticated-output progress by the absolute convergence deadline", async () => {
    const observations: MirrorFlowRecoveryObservation[] = [];
    const rig = await startedRig({
      continueReply: "manual",
      onFlowRecoveryObserved: (observation) => observations.push(observation),
    });
    const alpha = collect();
    rig.channel.subscribePane("pane.alpha", alpha.onEvent);
    rig.sim.reply(["seed"]);
    rig.sim.reply(["0 0 100 50"]);
    alpha.events.length = 0;

    rig.sim.feedLines("%pause %1");
    rig.sim.reply([]);
    for (let ordinal = 0; ordinal < 5; ordinal += 1) {
      advanceRecoveryClock(rig, 900);
      rig.sim.output("%1", `still-writing-${ordinal}`);
    }
    advanceRecoveryClock(rig, 500);

    expect(observations.at(-1)).toMatchObject({
      phase: "nonconverged",
      failureReason: "absolute-deadline",
    });
    expect(bytesOf(alpha.events)).toEqual([]);
    expect(rig.channel.flowSnapshot()).toEqual({
      backpressured: ["pane.alpha"],
      requested: [],
    });
    await rig.channel.dispose();
  });

  it("fails closed after the bounded number of final reseed attempts", async () => {
    const observations: MirrorFlowRecoveryObservation[] = [];
    const rig = await startedRig({
      onFlowRecoveryObserved: (observation) => observations.push(observation),
    });
    const alpha = collect();
    rig.channel.subscribePane("pane.alpha", alpha.onEvent);
    rig.sim.reply(["seed"]);
    rig.sim.reply(["0 0 100 50"]);
    alpha.events.length = 0;

    rig.sim.feedLines("%pause %1", "%continue %1");
    rig.sim.reply(["provisional"]);
    rig.sim.reply(["0 40 100 50"]);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      runRecoveryTimer(rig);
      rig.sim.reply([], false);
      rig.sim.reply([], false);
    }
    runRecoveryTimer(rig);

    expect(observations.at(-1)).toMatchObject({
      phase: "nonconverged",
      failureReason: "attempts-exhausted",
    });
    expect(bytesOf(alpha.events)).toEqual([]);
    expect(alpha.events.some((event) => event.type === "flow" && event.state === "resumed")).toBe(
      false,
    );
    await rig.channel.dispose();
  });

  it("waits for command success when continue notification arrives first", async () => {
    const phases: string[] = [];
    const rig = await startedRig({
      continueReply: "manual",
      onFlowRecoveryObserved: (observation) => phases.push(observation.phase),
    });
    const alpha = collect();
    rig.channel.subscribePane("pane.alpha", alpha.onEvent);
    rig.sim.reply(["seed"]);
    rig.sim.reply(["0 0 100 50"]);
    alpha.events.length = 0;

    rig.sim.feedLines("%pause %1", "%continue %1");
    expect(phases).toEqual(["pause", "continue-request", "continue-notify"]);
    expect(bytesOf(alpha.events)).toEqual([]);
    rig.sim.reply([], false);
    expect(phases.at(-1)).toBe("nonconverged");
    expect(rig.channel.flowSnapshot()).toEqual({
      backpressured: ["pane.alpha"],
      requested: [],
    });
    expect(alpha.events.some((event) => event.type === "flow" && event.state === "resumed")).toBe(
      false,
    );
    await rig.channel.dispose();
  });

  it("consumes a late old notification without touching a newer recovery", async () => {
    const observations: MirrorFlowRecoveryObservation[] = [];
    const rig = await startedRig({
      continueReply: "manual",
      onFlowRecoveryObserved: (observation) => observations.push(observation),
    });
    const alpha = collect();
    rig.channel.subscribePane("pane.alpha", alpha.onEvent);
    rig.sim.reply(["seed"]);
    rig.sim.reply(["0 0 100 50"]);
    alpha.events.length = 0;

    rig.sim.feedLines("%pause %1");
    rig.sim.reply([]);
    rig.sim.reply(["first-provisional"]);
    rig.sim.reply(["0 40 100 50"]);
    completeFinalContinueFence(rig);
    rig.sim.reply(["first-final"]);
    rig.sim.reply(["0 39 100 50"]);
    completeRecoveryConfirmations(rig, "first-final", "0 39 100 50");

    rig.sim.feedLines("%pause %1");
    const secondOrdinal = observations.at(-1)!.recoveryOrdinal;
    rig.sim.feedLines("%continue %1"); // late notification owed by the first recovery
    expect(
      observations.some(
        (observation) =>
          observation.recoveryOrdinal === secondOrdinal && observation.phase === "continue-notify",
      ),
    ).toBe(false);
    expect(
      observations.some(
        (observation) =>
          observation.recoveryOrdinal === secondOrdinal &&
          observation.phase === "provisional-reseed",
      ),
    ).toBe(false);
    rig.sim.reply([]);
    rig.sim.reply(["second-provisional"]);
    rig.sim.reply(["0 40 100 50"]);
    completeFinalContinueFence(rig);
    rig.sim.reply(["second-final"]);
    rig.sim.reply(["0 39 100 50"]);
    completeRecoveryConfirmations(rig, "second-final", "0 39 100 50");
    expect(observations.at(-1)).toMatchObject({
      recoveryOrdinal: secondOrdinal,
      phase: "converged",
    });
    await rig.channel.dispose();
  });

  it("keeps repeated missing continue notifications bounded and convergent", async () => {
    const phases: string[] = [];
    const rig = await startedRig({
      continueReply: "manual",
      onFlowRecoveryObserved: (observation) => phases.push(observation.phase),
    });
    const alpha = collect();
    rig.channel.subscribePane("pane.alpha", alpha.onEvent);
    rig.sim.reply(["seed"]);
    rig.sim.reply(["0 0 100 50"]);

    for (let ordinal = 0; ordinal < 40; ordinal += 1) {
      rig.sim.feedLines("%pause %1");
      rig.sim.reply([]);
      rig.sim.reply([`provisional-${ordinal}`]);
      rig.sim.reply(["0 40 100 50"]);
      completeFinalContinueFence(rig);
      rig.sim.reply([`final-${ordinal}`]);
      rig.sim.reply(["0 39 100 50"]);
      completeRecoveryConfirmations(rig, `final-${ordinal}`, "0 39 100 50");
    }

    expect(phases.filter((phase) => phase === "converged")).toHaveLength(40);
    expect(phases).not.toContain("continue-notify");
    expect(phases).not.toContain("nonconverged");
    expect(rig.channel.flowSnapshot()).toEqual({ backpressured: [], requested: [] });
    await rig.channel.dispose();
  });

  it("keeps a hung continue command quarantined until the fixed deadline", async () => {
    const observations: MirrorFlowRecoveryObservation[] = [];
    const rig = await startedRig({
      continueReply: "manual",
      onFlowRecoveryObserved: (observation) => observations.push(observation),
    });
    const alpha = collect();
    rig.channel.subscribePane("pane.alpha", alpha.onEvent);
    rig.sim.reply(["seed"]);
    rig.sim.reply(["0 0 100 50"]);
    alpha.events.length = 0;

    rig.sim.feedLines("%pause %1");
    rig.sim.output("%1", "must-remain-quarantined");
    runRecoveryTimer(rig, 500);
    expect(observations.map(({ phase }) => phase)).toEqual([
      "pause",
      "continue-request",
      "nonconverged",
    ]);
    expect(observations.at(-1)?.failureReason).toBe("command-timeout");
    expect(bytesOf(alpha.events)).toEqual([]);
    expect(rig.channel.flowSnapshot()).toEqual({
      backpressured: ["pane.alpha"],
      requested: [],
    });
    await rig.channel.dispose();
  });

  it("cannot recreate notification debt after disposal retires an in-flight command", async () => {
    const phases: string[] = [];
    const rig = await startedRig({
      continueReply: "manual",
      onFlowRecoveryObserved: (observation) => phases.push(observation.phase),
    });
    const alpha = collect();
    rig.channel.subscribePane("pane.alpha", alpha.onEvent);
    rig.sim.reply(["seed"]);
    rig.sim.reply(["0 0 100 50"]);
    alpha.events.length = 0;

    rig.sim.feedLines("%pause %1");
    await rig.channel.dispose();
    const eventCount = alpha.events.length;
    rig.sim.reply([]); // successful reply for the now-retired runtime
    rig.sim.feedLines("%continue %1");
    expect(continueNotificationQueueSize(rig.channel)).toBe(0);
    expect(alpha.events).toHaveLength(eventCount);
    expect(phases).toEqual(["pause", "continue-request"]);
  });

  it("retires overlapping recovery probes and cancels every timer on dispose", async () => {
    const rig = await startedRig();
    const alpha = collect();
    rig.channel.subscribePane("pane.alpha", alpha.onEvent);
    rig.sim.reply(["seed"]);
    rig.sim.reply(["0 0 100 50"]);
    alpha.events.length = 0;

    rig.sim.feedLines("%pause %1");
    rig.sim.feedLines("%pause %1", "%continue %1");
    rig.sim.reply([]);
    rig.sim.reply([]);
    expect(bytesOf(alpha.events)).toEqual([]);
    rig.sim.feedLines("%continue %1");
    rig.sim.reply(["CURRENT"]);
    rig.sim.reply(["0 39 100 50"]);
    runRecoveryTimer(rig);
    await rig.channel.dispose();
    for (const task of rig.pendingRecoveries) expect(task.cancelled).toBe(true);
    const count = alpha.events.length;
    for (const task of rig.pendingRecoveries) task.callback();
    expect(alpha.events).toHaveLength(count);
    expect(alpha.events.at(-1)).toEqual({ type: "closed" });
  });

  it("retries when output lands after the final cursor and converges only after a quiet seed", async () => {
    const phases: string[] = [];
    const rig = await startedRig({
      onFlowRecoveryObserved: (observation) => phases.push(observation.phase),
    });
    const alpha = collect();
    rig.channel.subscribePane("pane.alpha", alpha.onEvent);
    rig.sim.reply(["seed"]);
    rig.sim.reply(["0 0 100 50"]);
    alpha.events.length = 0;

    rig.sim.feedLines("%pause %1", "%continue %1");
    rig.sim.reply(["provisional"]);
    rig.sim.reply(["0 40 100 50"]);
    completeFinalContinueFence(rig);
    rig.sim.reply(["stale-final"]);
    rig.sim.reply(["0 40 100 50"]);
    rig.sim.output("%1", "LATE");
    runRecoveryTimer(rig);
    rig.sim.reply(["quiet-final"]);
    rig.sim.reply(["0 39 100 50"]);
    completeRecoveryConfirmations(rig, "quiet-final", "0 39 100 50");

    expect(bytesOf(alpha.events)).toEqual(["quiet-final"]);
    expect(phases.filter((phase) => phase === "final-reseed")).toHaveLength(2);
    expect(phases.at(-1)).toBe("converged");
    expect(alpha.events.filter((event) => event.type === "flow")).toEqual([
      { type: "flow", state: "paused", reason: "backpressure" },
      { type: "flow", state: "resumed", reason: "backpressure" },
    ]);
    await rig.channel.dispose();
  });

  it("fails a stalled recovery once at its bounded no-progress deadline without a late seed", async () => {
    const observations: MirrorFlowRecoveryObservation[] = [];
    const rig = await startedRig({
      onFlowRecoveryObserved: (observation) => observations.push(observation),
    });
    const alpha = collect();
    rig.channel.subscribePane("pane.alpha", alpha.onEvent);
    rig.sim.reply(["seed"]);
    rig.sim.reply(["0 0 100 50"]);
    alpha.events.length = 0;

    rig.sim.feedLines("%pause %1", "%continue %1");
    rig.sim.reply(["incomplete-capture"]);
    rig.sim.output("%1", "quarantined-output");
    advanceRecoveryClock(rig, 2_999);
    expect(observations.some(({ phase }) => phase === "nonconverged")).toBe(false);
    advanceRecoveryClock(rig, 1);
    expect(observations.at(-1)).toMatchObject({
      phase: "nonconverged",
      failureReason: "no-progress",
    });
    const observationCount = observations.length;
    advanceRecoveryClock(rig, 1);
    expect(observations).toHaveLength(observationCount);
    expect(bytesOf(alpha.events)).toEqual([]);
    const count = alpha.events.length;
    rig.sim.reply(["0 39 100 50"]);
    rig.sim.feedLines("%continue %1");
    expect(rig.channel.flowSnapshot()).toEqual({
      backpressured: ["pane.alpha"],
      requested: [],
    });
    for (const task of rig.pendingRecoveries) task.callback();
    expect(alpha.events).toHaveLength(count);
    expect(alpha.events.some((event) => event.type === "flow" && event.state === "resumed")).toBe(
      false,
    );
    await rig.channel.dispose();
  });

  it("turns a plain reseed overflow into a fresh bounded authoritative recovery", async () => {
    const rig = await startedRig();
    const alpha = collect();
    rig.channel.subscribePane("pane.alpha", alpha.onEvent);
    rig.sim.reply(["stale-capture"]);
    for (let index = 0; index < PaneFeed.MAX_HELD_CHUNKS; index += 1) rig.sim.output("%1", "x");
    rig.sim.output("%1", "z");
    expect(rig.sim.written.some((command) => command === "refresh-client -A '%1:continue'")).toBe(
      false,
    );
    expect(bytesOf(alpha.events)).toEqual([]);
    rig.sim.reply(["0 40 100 50"]);
    rig.sim.reply(["provisional"]);
    rig.sim.reply(["0 40 100 50"]);
    completeFinalContinueFence(rig);
    rig.sim.reply(["authoritative"]);
    rig.sim.reply(["0 39 100 50"]);
    completeRecoveryConfirmations(rig, "authoritative", "0 39 100 50");
    expect(bytesOf(alpha.events).at(-1)).toBe("authoritative");
    expect(alpha.events.filter((event) => event.type === "flow")).toEqual([
      { type: "flow", state: "paused", reason: "backpressure" },
      { type: "flow", state: "resumed", reason: "backpressure" },
    ]);
    await rig.channel.dispose();
  });

  it("cancels in-flight recovery for an all-frozen pane and thaws through a fresh epoch", async () => {
    const rig = await startedRig();
    const alpha = collect();
    const handle = rig.channel.subscribePane("pane.alpha", alpha.onEvent);
    rig.sim.reply(["seed"]);
    rig.sim.reply(["0 0 100 50"]);
    alpha.events.length = 0;

    rig.sim.feedLines("%pause %1", "%continue %1");
    handle.freeze();
    rig.sim.reply([]);
    const frozenCount = alpha.events.length;
    rig.sim.reply(["late-seed"]);
    rig.sim.reply(["0 39 100 50"]);
    expect(alpha.events).toHaveLength(frozenCount);

    handle.thaw();
    completeRecovery(rig, "%1", "fresh-provisional", "fresh-final", "0 39 100 50");
    expect(bytesOf(alpha.events)).toEqual(["fresh-final"]);
    expect(alpha.events.filter((event) => event.type === "flow").at(-1)).toEqual({
      type: "flow",
      state: "resumed",
      reason: "requested",
    });
    await rig.channel.dispose();
  });

  it("does not reserve a continue notification for a command that failed", async () => {
    const phases: string[] = [];
    const rig = await startedRig({
      onFlowRecoveryObserved: (observation) => phases.push(observation.phase),
      continueReply: "manual",
    });
    const alpha = collect();
    rig.channel.subscribePane("pane.alpha", alpha.onEvent);
    rig.sim.reply(["seed"]);
    rig.sim.reply(["0 0 100 50"]);
    alpha.events.length = 0;

    rig.sim.feedLines("%pause %1");
    rig.sim.reply([], false);
    rig.sim.feedLines("%pause %1", "%continue %1");
    rig.sim.reply([]);
    rig.sim.reply(["authoritative"]);
    rig.sim.reply(["0 39 100 50"]);
    completeRecoveryConfirmations(rig, "authoritative", "0 39 100 50");
    expect(bytesOf(alpha.events)).toEqual(["authoritative"]);
    await rig.channel.dispose();
  });

  it("keeps the continue handshake intact when output floods an older cursor probe", async () => {
    const phases: string[] = [];
    const rig = await startedRig({
      onFlowRecoveryObserved: (observation) => phases.push(observation.phase),
      continueReply: "manual",
    });
    const alpha = collect();
    rig.channel.subscribePane("pane.alpha", alpha.onEvent);
    rig.sim.reply(["old-capture"]);
    for (let index = 0; index < PaneFeed.MAX_HELD_CHUNKS; index += 1) rig.sim.output("%1", "old");

    rig.sim.feedLines("%pause %1");
    rig.sim.output("%1", "while-continuing");
    expect(bytesOf(alpha.events)).toEqual([]);
    rig.sim.reply(["0 40 100 50"]);
    rig.sim.feedLines("%continue %1");
    rig.sim.reply([]);
    rig.sim.reply(["authoritative"]);
    rig.sim.reply(["0 39 100 50"]);
    completeRecoveryConfirmations(rig, "authoritative", "0 39 100 50");
    expect(phases).toEqual([
      "pause",
      "continue-request",
      "continue-notify",
      "continue-reply",
      "final-reseed",
      "confirmation-reseed",
      "confirmation-reseed",
      "converged",
    ]);
    expect(bytesOf(alpha.events)).toEqual(["authoritative"]);
    await rig.channel.dispose();
  });

  it("closes old-semantic subscribers when one runtime is restamped during recovery", async () => {
    const rig = await startedRig();
    const oldSemantic = collect();
    rig.channel.subscribePane("pane.alpha", oldSemantic.onEvent);
    rig.sim.reply(["old-seed"]);
    rig.sim.reply(["0 0 100 50"]);
    oldSemantic.events.length = 0;
    rig.sim.feedLines("%pause %1");
    rig.sim.reply(["provisional-old-authority"]);
    rig.sim.reply(["0 40 100 50"]);

    rig.state.descriptorRows[0] = rig.state.descriptorRows[0]!.replace(
      "%1\tpane.alpha\t",
      "%1\tpane.replacement\t",
    );
    rig.sim.feedLines("%layout-change @1 aaaa,200x50,0,0,2 aaaa,200x50,0,0,2 0");
    expect(rig.pendingSyncs).toHaveLength(1);
    rig.pendingSyncs.shift()!();
    await vi.waitFor(() => expect(oldSemantic.events.at(-1)).toEqual({ type: "closed" }));
    await vi.waitFor(() =>
      expect(
        rig.channel.describe().panes.some((pane) => pane.semanticPaneId === "pane.replacement"),
      ).toBe(true),
    );
    expect(continueNotificationQueueSize(rig.channel)).toBe(0);
    const oldCount = oldSemantic.events.length;
    rig.sim.feedLines("%continue %1");
    rig.sim.output("%1", "new-authority-output");
    expect(oldSemantic.events).toHaveLength(oldCount);

    const replacement = collect();
    rig.channel.subscribePane("pane.replacement", replacement.onEvent);
    rig.sim.reply(["replacement-seed"]);
    rig.sim.reply(["0 0 100 50"]);
    expect(bytesOf(replacement.events)).toEqual(["replacement-seed"]);
    await rig.channel.dispose();
  });
});

describe("layout push", () => {
  it("emits joined layout events ahead of subsequent output, in channel order", async () => {
    const rig = await startedRig();
    const order: string[] = [];
    const layouts: MirrorLayoutEvent[] = [];
    rig.channel.subscribePane(
      "pane.alpha",
      (event) => order.push(event.type),
      (event) => {
        layouts.push(event);
        order.push("layout");
      },
    );
    rig.sim.reply(["s"]);
    rig.sim.reply(["0 0 100 50"]);
    order.length = 0;

    // One chunk: the layout notification, then output at the new size — the
    // channel-order invariant says the layout event must be seen first.
    rig.sim.feedLines(
      `%layout-change @1 ${FIXTURE.layoutW1} aaaa,200x50,0,0{150x50,0,0,1,49x50,151,0,2} 0`,
      "%output %1 NEWSIZE",
    );
    expect(order).toEqual(["layout", "delta"]);
    const layout = layouts.at(-1)!;
    expect(layout.semanticWindowId).toBe("window.test.one");
    expect(layout.session).toBe(FIXTURE.session);
    expect(layout.cols).toBe(200);
    expect(layout.panes.map((pane) => pane.semanticPaneId)).toEqual(["pane.alpha", "pane.beta"]);
    expect(layout.panes[0]!.width).toBe(150);
    await rig.channel.dispose();
  });

  it("hands a new pane subscriber only its owning window geometry immediately", async () => {
    /*
     * Bug this catches — and it did, on the first live run of the layout-faithful
     * view: layout frames were emitted only when a layout CHANGED, so a view
     * built from them opened empty and stayed empty until the user moved
     * something. It read as the app failing to find the session's windows.
     */
    const rig = await startedRig();
    const layouts: MirrorLayoutEvent[] = [];
    rig.channel.subscribePane(
      "pane.alpha",
      () => {},
      (event) => layouts.push(event),
    );
    expect(layouts.map((event) => event.semanticWindowId)).toEqual(["window.test.one"]);
    // Every pane names an identity. A frame that arrives before the stamp-back
    // carries nulls, and a consumer that renders semantic ids draws nothing for
    // them — which is how a freshly split pane goes missing from the view.
    expect(layouts.every((event) => event.panes.every((pane) => pane.semanticPaneId))).toBe(true);
    await rig.channel.dispose();
  });

  it("never broadcasts one window layout to a subscriber owned by another window", async () => {
    const rig = await startedRig();
    const alphaLayouts: MirrorLayoutEvent[] = [];
    const gammaLayouts: MirrorLayoutEvent[] = [];
    rig.channel.subscribePane(
      "pane.alpha",
      () => {},
      (event) => alphaLayouts.push(event),
    );
    rig.sim.reply(["a"]);
    rig.sim.reply(["0 0 100 50"]);
    rig.channel.subscribePane(
      "pane.mirror.gen1",
      () => {},
      (event) => gammaLayouts.push(event),
    );
    rig.sim.reply(["g"]);
    rig.sim.reply(["0 0 200 50"]);
    expect(alphaLayouts.map((event) => event.semanticWindowId)).toEqual(["window.test.one"]);
    expect(gammaLayouts.map((event) => event.semanticWindowId)).toEqual(["window.test.two"]);
    alphaLayouts.length = 0;
    gammaLayouts.length = 0;

    rig.sim.feedLines(`%layout-change @2 ${FIXTURE.layoutW2} ${FIXTURE.layoutW2} 0`);
    expect(alphaLayouts).toEqual([]);
    expect(gammaLayouts.map((event) => event.semanticWindowId)).toEqual(["window.test.two"]);
    gammaLayouts.length = 0;
    rig.sim.feedLines(`%layout-change @1 ${FIXTURE.layoutW1} ${FIXTURE.layoutW1} 0`);
    expect(alphaLayouts.map((event) => event.semanticWindowId)).toEqual(["window.test.one"]);
    expect(gammaLayouts).toEqual([]);
    await rig.channel.dispose();
  });

  it("emits the exact new owning layout after a delayed truth-sync pane move", async () => {
    const rig = await startedRig();
    const layouts: MirrorLayoutEvent[] = [];
    rig.channel.subscribePane(
      "pane.alpha",
      () => {},
      (event) => layouts.push(event),
    );
    rig.sim.reply(["a"]);
    rig.sim.reply(["0 0 100 50"]);
    layouts.length = 0;

    const oldWithoutAlpha = "cccc,200x50,0,0,2";
    const newWithAlpha = "dddd,200x50,0,0{100x50,0,0,1,99x50,101,0,3}";
    // Tmux publishes the destination layout before list-panes truth has moved
    // the record, so the pane-scoped subscriber correctly does not see it yet.
    rig.sim.feedLines(`%layout-change @2 ${FIXTURE.layoutW2} ${newWithAlpha} 0`);
    expect(layouts).toEqual([]);
    // The old owning layout is relevant and invalidates the old lease.
    rig.sim.feedLines(`%layout-change @1 ${FIXTURE.layoutW1} ${oldWithoutAlpha} 0`);
    expect(layouts.map((event) => event.semanticWindowId)).toEqual(["window.test.one"]);
    expect(layouts[0]!.panes.some((pane) => pane.semanticPaneId === "pane.alpha")).toBe(false);

    rig.state.truthRows = ["%1\t1\t@2\t1", "%2\t1\t@1\t0", "%3\t0\t@2\t1"];
    rig.state.windowRows = FIXTURE.windowRows(oldWithoutAlpha, newWithAlpha);
    expect(rig.pendingSyncs).toHaveLength(1);
    rig.pendingSyncs.shift()!();

    await vi.waitFor(() => {
      expect(layouts.some((event) => event.semanticWindowId === "window.test.two")).toBe(true);
    });
    const movedIndex = layouts.findIndex((event) => event.semanticWindowId === "window.test.two");
    expect(movedIndex).toBeGreaterThan(0);
    expect(
      layouts.slice(movedIndex).every((event) => event.semanticWindowId === "window.test.two"),
    ).toBe(true);
    const moved = layouts[movedIndex]!;
    expect(moved.panes.find((pane) => pane.semanticPaneId === "pane.alpha")).toMatchObject({
      width: 100,
      height: 50,
      active: true,
    });
    await rig.channel.dispose();
  });

  it("re-flags the active pane from %window-pane-changed", async () => {
    const rig = await startedRig();
    const layouts: MirrorLayoutEvent[] = [];
    rig.channel.subscribePane(
      "pane.beta",
      () => {},
      (event) => layouts.push(event),
    );
    rig.sim.reply(["s"]);
    rig.sim.reply(["0 0 99 50"]);
    rig.sim.feedLines(`%layout-change @1 ${FIXTURE.layoutW1} ${FIXTURE.layoutW1} 0`);
    rig.sim.feedLines("%window-pane-changed @1 %2");
    const layout = layouts.at(-1)!;
    expect(layout.panes.find((pane) => pane.semanticPaneId === "pane.beta")!.active).toBe(true);
    await rig.channel.dispose();
  });

  it("keeps pane layout delivery scoped while global layout listeners receive both windows", async () => {
    /*
     * Bug this catches: `currentWindow` is carried on the layout frame and only
     * %session-window-changed moves it, so without a re-emit a view whose window
     * tabs come from these frames keeps marking the window the user just left as
     * the one they are in — until something unrelated happens to change a layout.
     */
    const rig = await startedRig();
    const paneLayouts: MirrorLayoutEvent[] = [];
    const globalLayouts: MirrorLayoutEvent[] = [];
    rig.channel.subscribePane(
      "pane.alpha",
      () => {},
      (event) => paneLayouts.push(event),
    );
    const global = rig.channel.subscribeLayout((event) => globalLayouts.push(event));
    rig.sim.reply(["s"]);
    rig.sim.reply(["0 0 100 50"]);
    // Seed a layout for both windows so each has geometry to re-emit.
    rig.sim.feedLines(`%layout-change @1 ${FIXTURE.layoutW1} ${FIXTURE.layoutW1} 0`);
    rig.sim.feedLines(`%layout-change @2 ${FIXTURE.layoutW2} ${FIXTURE.layoutW2} 0`);
    paneLayouts.length = 0;
    globalLayouts.length = 0;

    rig.sim.feedLines("%session-window-changed $0 @2");

    expect(paneLayouts.map((event) => event.semanticWindowId)).toEqual(["window.test.one"]);
    const byWindow = new Map(
      globalLayouts.map((event) => [event.semanticWindowId, event.currentWindow]),
    );
    expect(byWindow.get("window.test.two")).toBe(true);
    // The window that was left says so in the same burst, so no tab is left
    // claiming to be current alongside the new one.
    expect(byWindow.get("window.test.one")).toBe(false);
    global.close();
    await rig.channel.dispose();
  });
});

describe("closure (truth-driven, never probe-failure)", () => {
  it("closes a subscribed pane only when a successful truth reply omits it", async () => {
    const rig = await startedRig();
    const gamma = collect();
    rig.channel.subscribePane("pane.mirror.gen1", gamma.onEvent);
    rig.sim.reply(["g"]);
    rig.sim.reply(["0 0 200 50"]);
    gamma.events.length = 0;

    rig.sim.feedLines("%pause %3");
    rig.sim.reply(["provisional"]);
    rig.sim.reply(["0 40 200 50"]);
    runRecoveryTimer(rig);
    rig.sim.reply(["final"]);
    rig.sim.reply(["0 39 200 50"]);
    completeRecoveryConfirmations(rig, "final", "0 39 200 50");
    expect(continueNotificationQueueSize(rig.channel)).toBe(1);
    gamma.events.length = 0;

    rig.state.truthRows.splice(2, 1); // %3 is gone from tmux truth
    rig.state.descriptorRows.splice(2, 1);
    rig.sim.feedLines("%window-close @2");
    expect(rig.pendingSyncs).toHaveLength(1);
    rig.pendingSyncs.pop()!();
    await vi.waitFor(() => {
      expect(gamma.events).toEqual([{ type: "closed" }]);
    });
    expect(
      rig.channel
        .describe()
        .panes.map((pane) => pane.semanticPaneId)
        .sort(),
    ).toEqual(["pane.alpha", "pane.beta"]);
    expect(continueNotificationQueueSize(rig.channel)).toBe(0);
    await rig.channel.dispose();
  });

  it("schedules a truth sync when a known pane vanishes from a surviving window's layout", async () => {
    const rig = await startedRig();
    const beta = collect();
    rig.channel.subscribePane("pane.beta", beta.onEvent);
    rig.sim.reply(["b"]);
    rig.sim.reply(["0 0 99 50"]);
    beta.events.length = 0;

    // kill-pane on %2: window @1 survives, so tmux emits ONLY %layout-change
    // whose leaves are all already known. The truth now omits %2; without a
    // sync its subscriber would never receive `closed`.
    rig.state.truthRows.splice(1, 1);
    rig.state.descriptorRows.splice(1, 1);
    rig.sim.feedLines("%layout-change @1 cccc,200x50,0,0,1 cccc,200x50,0,0,1 0");
    expect(rig.pendingSyncs.length).toBeGreaterThan(0);
    rig.pendingSyncs.pop()!();
    await vi.waitFor(() => {
      expect(beta.events).toEqual([{ type: "closed" }]);
    });
    expect(
      rig.channel
        .describe()
        .panes.map((pane) => pane.semanticPaneId)
        .sort(),
    ).toEqual(["pane.alpha", "pane.mirror.gen1"]);
    await rig.channel.dispose();
  });
});

describe("input path", () => {
  it("coalesces literals per pane and sends named keys after pending literals", async () => {
    const rig = await startedRig();
    const handle = rig.channel.subscribePane("pane.alpha", () => {});
    rig.sim.reply(["s"]);
    rig.sim.reply(["0 0 100 50"]);
    const before = rig.sim.written.length;
    handle.sendText("hi");
    handle.sendText("!");
    rig.channel.fitViewport(120, 40);
    handle.sendKey("Enter");
    const sent = rig.sim.written.slice(before);
    expect(sent).toEqual([
      "send-keys -t %1 -H 68 69 21",
      "refresh-client -C 120x40",
      "send-keys -t %1 Enter",
    ]);
    await rig.channel.dispose();
  });

  it("changes geometry participation only on authority edges", async () => {
    const rig = await startedRig();
    const before = rig.sim.written.length;
    rig.channel.setGeometryParticipation(true);
    rig.channel.setGeometryParticipation(true);
    rig.channel.setGeometryParticipation(false);
    rig.channel.setGeometryParticipation(false);
    expect(rig.sim.written.slice(before)).toEqual([
      "refresh-client -f !ignore-size",
      "refresh-client -f ignore-size",
    ]);
    await rig.channel.dispose();
  });
});

describe("age telemetry", () => {
  it("retains %extended-output ages keyed by semantic pane id", async () => {
    const onOutputObserved = vi.fn();
    const rig = await startedRig({ onOutputObserved });
    const alpha = collect();
    rig.channel.subscribePane("pane.alpha", alpha.onEvent);
    rig.sim.reply(["s"]);
    rig.sim.reply(["0 0 100 50"]);
    rig.sim.feedLines("%extended-output %1 750 : flooded");
    expect(bytesOf(alpha.events)).toEqual(["s", "flooded"]);
    expect(rig.channel.ageTelemetry()).toEqual({
      maxAgeMs: 750,
      byPane: { "pane.alpha": 750 },
    });
    expect(onOutputObserved).toHaveBeenCalledWith("pane.alpha", 750, undefined);
    await rig.channel.dispose();
  });
});
