/**
 * SessionChannel unit tests over a simulated control channel (the real
 * ControlChannelCore fed raw protocol lines — see __tests__/simulated-channel).
 */
import { describe, expect, it, vi } from "vitest";
import type { CanonicalTerminalReplicaUpdate } from "@tmux-ide/contracts";
import { hostname } from "node:os";
import { memorablePaneName } from "../protocol/pane-display-name.ts";
import {
  SimulatedChannel,
  fixtureAutoReply,
  fixtureState,
  FIXTURE,
  type FixtureState,
} from "./__tests__/simulated-channel.ts";
import type {
  MirrorLayoutAuthoritySnapshot,
  MirrorLayoutEvent,
  MirrorPaneEvent,
} from "./events.ts";
import { SessionRuntimeTerminalReplicaOwner } from "../session-runtime/terminal-replica-owner.ts";
import { createSessionRuntimeObservability } from "../session-runtime/runtime-observability.ts";
import type { MirrorSubscribeRequest } from "./mirror-service.ts";
import { SessionChannel } from "./session-channel.ts";
import type { MirrorFlowRecoveryObservation } from "./session-channel.ts";
import type { SessionChannelOptions } from "./session-channel.ts";
import type { MirrorOutputTiming } from "./control-channel.ts";
import type { AtomicPaneSnapshotCollector } from "./control-channel.ts";
import {
  INTERNAL_READ_OPERATION_OPTION,
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
  atomicInvocationAuthorizations: boolean[];
  atomicHookValues: Map<string, string>;
  armedAtomicCollectors: AtomicPaneSnapshotCollector[];
}

async function startedRig(
  options: {
    ownedViewer?: SessionChannelOptions["ownedViewer"];
    nativeBirth?: string;
    executeWindowLinkGuard?: (args: string[]) => Promise<{ status: number | null; stdout: string }>;
    onNativeClientActivity?: () => void;
    onOutputObserved?: (
      semanticPaneId: string,
      ageMs: number | null,
      timing?: MirrorOutputTiming,
    ) => void;
    onFlowRecoveryObserved?: (observation: MirrorFlowRecoveryObservation) => void;
    continueReply?: "auto-success" | "manual";
    borderReply?: "manual";
    descriptorReply?: { manual: boolean };
    historyLines?: number;
    atomicHook?: boolean;
    replaceAtomicHookBeforeInvoke?: boolean;
    manualAfterPauseSetup?: boolean;
  } = {},
): Promise<Rig> {
  options = { ...options, atomicHook: options.atomicHook ?? true };
  const state = fixtureState();
  if (options.nativeBirth)
    state.descriptorRows = state.descriptorRows.map((row) => row + options.nativeBirth);
  const pendingSyncs: Array<() => void> = [];
  const recoveryClock = { nowMs: 0 };
  const pendingRecoveries: Rig["pendingRecoveries"] = [];
  let atomicNonceOrdinal = 0;
  let pauseSetupWritten = false;
  const atomicInvocationAuthorizations: boolean[] = [];
  const atomicHookValues = new Map<string, string>();
  const armedAtomicCollectors: AtomicPaneSnapshotCollector[] = [];
  let sim: SimulatedChannel | null = null;
  const channel = new SessionChannel({
    ownedViewer: options.ownedViewer,
    session: FIXTURE.session,
    executeWindowLinkGuard: options.executeWindowLinkGuard,
    createIo: (handlers) => {
      const autoReply = fixtureAutoReply(state);
      sim = new SimulatedChannel(handlers, (command) => {
        if (options.manualAfterPauseSetup) {
          pauseSetupWritten ||= /^set-option -po -t %\d+ @tmux_ide_pause_/u.test(command);
          if (pauseSetupWritten) return null;
        }
        if (command.startsWith("display-message -p -l tmux-ide-snapshot-admission:"))
          return [command.slice("display-message -p -l ".length)];
        if (options.descriptorReply?.manual && command.includes("qa:@tmux_ide_pane_id"))
          return null;
        if (options.borderReply === "manual" && command.endsWith('"#{pane-border-status}"'))
          return null;
        if (options.atomicHook && /^set-option -po -t %[0-9]+ @tmux_ide_atomic_/u.test(command)) {
          const created = /^set-option -po -t %[0-9]+ (@[^ ]+) (.+)$/u.exec(command);
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
        if (options.atomicHook && /set-hook -Rp -t %[0-9]+ @tmux_ide_atomic_/u.test(command)) {
          const nonce = /@tmux_ide_atomic_([0-9a-f]{32,128})/u.exec(command)?.[1];
          const authorized =
            nonce !== undefined &&
            atomicHookValues.get(`@tmux_ide_atomic_owner_${nonce}`) === nonce &&
            atomicHookValues.get(`@tmux_ide_atomic_${nonce}`) ===
              atomicHookValues.get(`@tmux_ide_atomic_expected_${nonce}`);
          atomicInvocationAuthorizations.push(authorized);
          return authorized ? [] : [`tmux-ide-atomic-invoke-rejected-v1:${nonce ?? "invalid"}`];
        }
        return options.continueReply === "manual" && command.startsWith("refresh-client -A")
          ? null
          : autoReply(command);
      });
      if (options.atomicHook) {
        // Native stdout cannot reenter its own read callback. Cleanup commands
        // sent during collector settlement get their replies after that block
        // finishes and the collector emits onDrained, just like the real pipe.
        let settlingCollector = false;
        let feedDepth = 0;
        const deferredReplies: Array<() => void> = [];
        const reply = sim.reply.bind(sim);
        const feedLines = sim.feedLines.bind(sim);
        sim.reply = (lines, ok = true) => {
          if (settlingCollector) deferredReplies.push(() => reply(lines, ok));
          else reply(lines, ok);
        };
        sim.feedLines = (...lines) => {
          feedDepth += 1;
          try {
            feedLines(...lines);
          } finally {
            feedDepth -= 1;
            if (feedDepth === 0) while (deferredReplies.length > 0) deferredReplies.shift()!();
          }
        };
        Object.assign(sim, {
          armAtomicPaneSnapshotCollector: (spec: AtomicPaneSnapshotCollector) => {
            const accepted = sim!.core.armAtomicPaneSnapshotCollector({
              ...spec,
              onSettled: (result) => {
                settlingCollector = true;
                try {
                  spec.onSettled(result);
                } finally {
                  settlingCollector = false;
                }
              },
            });
            if (accepted) armedAtomicCollectors.push(spec);
            return accepted;
          },
          retireAtomicPaneSnapshotCollector: (nonce: string) =>
            sim!.core.retireAtomicPaneSnapshotCollector(nonce),
        });
      }
      if (options.borderReply || options.descriptorReply) {
        // Automatic replies cannot overtake an older manual metadata command.
        // Reserve every command-list slot before dispatch, just like the core.
        type Slot = { reply?: { lines: string[]; ok: boolean } };
        const slots: Slot[] = [];
        let operation: { slots: Slot[]; next: number } | null = null;
        let flushing = false;
        const emit = sim.reply.bind(sim);
        const flush = () => {
          if (flushing || operation) return;
          flushing = true;
          try {
            while (slots[0]?.reply) {
              const reply = slots.shift()!.reply!;
              emit(reply.lines, reply.ok);
            }
          } finally {
            flushing = false;
          }
        };
        sim.reply = (lines, ok = true) => {
          if (operation) operation.slots[operation.next++]!.reply = { lines, ok };
          else if (slots.length) {
            expect(slots[0]!.reply).toBeUndefined();
            slots[0]!.reply = { lines, ok };
          } else emit(lines, ok);
          flush();
        };
        for (const method of [
          "request",
          "send",
          "commandInline",
          "commandListInline",
          "commandListBoundedInline",
        ] as const) {
          const original = sim[method].bind(sim) as (...args: unknown[]) => unknown;
          const wrapped = (...args: unknown[]) => {
            const count =
              method === "commandListInline" || method === "commandListBoundedInline"
                ? (args[1] as number)
                : 1;
            const own = Array.from({ length: count }, () => ({}) as Slot);
            slots.push(...own);
            const previous = operation;
            operation = { slots: own, next: 0 };
            try {
              return original(...args);
            } finally {
              operation = previous;
              flush();
            }
          };
          Object.assign(sim, { [method]: wrapped });
        }
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
    atomicInvocationAuthorizations,
    atomicHookValues,
    armedAtomicCollectors,
  };
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
    runtimePaneId?: string;
    ansiCaptureLines?: readonly string[];
  } = {},
): string {
  const runtimePaneId = options.runtimePaneId ?? "%1";
  const collector = rig.armedAtomicCollectors.at(-1);
  expect(collector?.kind).not.toBe("pause");
  expect(collector?.runtimePaneId).toBe(runtimePaneId);
  const nonce = collector!.nonce;
  const hookBody = [...rig.sim.written]
    .reverse()
    .find((command) =>
      command.startsWith(`set-option -po -t ${runtimePaneId} @tmux_ide_atomic_expected_${nonce}`),
    );
  const marker = /tmux-ide-internal-read-v2:[0-9a-f-]+/u.exec(hookBody ?? "")?.[0];
  expect(marker).toBeDefined();
  expect(
    rig.sim.written.some((command) =>
      command.includes(`set-hook -Rp -t ${runtimePaneId} @tmux_ide_atomic_${nonce}`),
    ),
  ).toBe(true);
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
    ...(rig.armedAtomicCollectors.at(-1)?.dualCapture
      ? [
          ...guarded(...(options.ansiCaptureLines ?? [])),
          ...guarded(`%tmux-ide-atomic-v1 ${nonce} ansi-capture-end`),
        ]
      : []),
    ...guarded(cursorLine),
    ...guarded(`%tmux-ide-atomic-v1 ${nonce} cursor-end`),
    ...guarded(...(options.continueNotify ? [`%continue ${runtimePaneId}`] : [])),
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

/** Model the transport's separately queued ordinary fence, not an inline
 * callback that would incorrectly release ownership before native guards drain. */
function drainRetiredAtomicCollector(rig: Rig, nonce: string): void {
  const fence = `tmux-ide-collector-drain-v1:${nonce}`;
  const observed = vi.fn();
  rig.sim.commandInline(`display-message -p -l ${fence}`, (reply) => {
    expect(reply).toEqual({ ok: true, lines: [fence] });
    expect(rig.sim.core.releaseRetiredCollector(nonce)).toBe(true);
    observed();
  });
  // Late flags=0 hook output, even a row equal to the fence, does not
  // consume the ordinary flags=1 reply or release the retired owner.
  rig.sim.feedLines("%begin 1 1901 0", fence, "%end 1 1901 0");
  expect(observed).not.toHaveBeenCalled();
  rig.sim.output("%2", "BEFORE-DRAIN-FENCE");
  rig.sim.reply([fence]);
  expect(observed).toHaveBeenCalledOnce();
  rig.sim.output("%2", "AFTER-DRAIN-FENCE");
}

/** Emit the actual three-command NOHOOKS pause transcript. The stock
 * transaction must not start its snapshot until the terminal guard drains. */
function completeStockPause(rig: Rig, runtimePaneId: string, observed = true): void {
  const collector = rig.armedAtomicCollectors.at(-1);
  expect(collector).toMatchObject({ kind: "pause", runtimePaneId });
  const nonce = collector!.nonce;
  rig.sim.feedLines(
    "%begin 1 1801 0",
    `%tmux-ide-atomic-v1 ${nonce} start`,
    "%end 1 1801 0",
    "%begin 1 1802 0",
    ...(observed ? [`%pause ${runtimePaneId}`] : []),
    "%end 1 1802 0",
  );
  expect(rig.armedAtomicCollectors.at(-1)).toBe(collector);
  rig.sim.feedLines("%begin 1 1803 0", `%tmux-ide-atomic-v1 ${nonce} complete`, "%end 1 1803 0");
}

/** Complete one requested snapshot through the actual stock pause and
 * guarded capture transcript. Tests that interleave either boundary stay manual. */
function completeSeed(rig: Rig, lines: readonly string[], cursor: string): void {
  if (rig.sim.written.at(-1)?.includes("capture-pane -p -R -S -")) rig.sim.reply([...lines]);
  const collector = rig.armedAtomicCollectors.at(-1);
  if (collector?.kind === "pause") completeStockPause(rig, collector.runtimePaneId);
  completeAtomicRecoveryPhase(rig, lines, cursor, {
    continueNotify: true,
    runtimePaneId: rig.armedAtomicCollectors.at(-1)!.runtimePaneId,
  });
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

describe("identity join", () => {
  it("publishes stable generated shell names when tmux titles equal the server short hostname", async () => {
    const state = fixtureState();
    state.descriptorRows = state.descriptorRows.map((row, index) => {
      const fields = row.split("\t");
      fields[4] = "bash";
      fields[9] = hostname().split(".")[0]!;
      if (index === 0) fields[12] = memorablePaneName("pane.alpha");
      return fields.join("\t");
    });
    const channel = new SessionChannel({
      session: FIXTURE.session,
      createIo: (handlers) => new SimulatedChannel(handlers, fixtureAutoReply(state)),
      generatePaneId: () => "pane.mirror.gen1",
    });
    const layouts: MirrorLayoutEvent[] = [];
    channel.subscribeLayout((event) => layouts.push(event));
    try {
      await channel.start();
      expect(
        layouts
          .flatMap((event) => event.panes)
          .find((pane) => pane.semanticPaneId === "pane.alpha"),
      ).toMatchObject({
        displayName: memorablePaneName("pane.alpha"),
        displayNameSource: "generated",
      });
      expect(
        channel.describe().panes.find((pane) => pane.semanticPaneId === "pane.alpha"),
      ).toMatchObject({
        displayName: memorablePaneName("pane.alpha"),
        displayNameSource: "generated",
      });
      expect(
        channel.describe().panes.find((pane) => pane.semanticPaneId === "pane.beta"),
      ).toMatchObject({ displayName: "Beta IDE", displayNameSource: "manual" });
    } finally {
      await channel.dispose();
    }
  });

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
            ? [Buffer.from(`"${session}"\t$1\t1234\t1700000000`, "utf8").toString("latin1")]
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

  it("keeps full membership and hidden pane geometry through native zoom without a truth rebind", async () => {
    const rig = await startedRig();
    const { channel, sim, state, pendingSyncs } = rig;
    state.descriptorRows[2] = state.descriptorRows[2]!.replace(
      "%3\t\t",
      "%3\tpane.mirror.gen1\t",
    ).replace("\t\tzz-sim", "\twindow.test.two\tzz-sim");
    const visible = "aaaa,200x50,0,0,1";
    state.windowRows = FIXTURE.windowRows(visible, FIXTURE.layoutW2);
    state.windowRows[0] = state.windowRows[0]!.replace("\t0\toff", `\t1\toff\t${FIXTURE.layoutW1}`);
    const trusted = await channel.describeTrustedInventory("$1");
    expect(trusted.panes).toHaveLength(3);
    const global: MirrorLayoutEvent[] = [];
    const sub = await channel.subscribeAuthoritativeLayout(
      (e) => global.push(e),
      ["pane.alpha", "pane.beta", "pane.mirror.gen1"],
    );
    expect(global.find((e) => e.zoomed)?.panes).toHaveLength(1);
    const hidden: MirrorLayoutEvent[] = [];
    channel.subscribePane(
      "pane.beta",
      () => {},
      (e) => hidden.push(e),
    );
    expect(hidden.at(-1)?.panes.find((p) => p.semanticPaneId === "pane.beta")?.width).toBe(99);
    completeSeed(rig, ["hidden"], "0 0 99 50");
    const queued = pendingSyncs.length;
    sim.feedLines(`%layout-change @1 ${FIXTURE.layoutW1} ${visible} *Z`);
    expect(pendingSyncs.length).toBe(queued);
    await sub.close();
    await channel.dispose();
  });

  it.each([
    { kind: "zoom", borderReply: "manual" as const },
    { kind: "zoom", borderReply: undefined },
    { kind: "resize", borderReply: "manual" as const },
    { kind: "resize", borderReply: undefined },
  ])(
    "keeps a newer $kind notification when an older window truth read completes (border: $borderReply)",
    async ({ kind, borderReply }) => {
      const descriptorReply = { manual: false };
      const rig = await startedRig({ borderReply, descriptorReply });
      // Keep later descriptor reads behind the manually held border reply.
      descriptorReply.manual = true;
      const layouts: MirrorLayoutEvent[] = [];
      const subscription = rig.channel.subscribeLayout((event) => layouts.push(event));
      const originalRequest = rig.sim.request.bind(rig.sim);
      let injected = false;
      rig.sim.request = async (command) => {
        const reply = await originalRequest(command);
        if (command.startsWith("list-windows") && !injected) {
          injected = true;
          // A control read resolves its promise before processing the next
          // notification in the same chunk. Its continuation must not erase it.
          const visible =
            kind === "zoom" ? "aaaa,200x50,0,0,1" : "aaaa,200x50,0,0{150x50,0,0,1,49x50,151,0,2}";
          rig.sim.feedLines(
            `%layout-change @1 ${FIXTURE.layoutW1} ${visible} ${kind === "zoom" ? "*Z" : "*"}`,
          );
        }
        return reply;
      };
      try {
        rig.sim.feedLines("%window-renamed @1 main");
        rig.pendingSyncs.shift()!();
        await vi.waitFor(() => expect(injected).toBe(true));
        if (borderReply === "manual") rig.sim.reply(["off"]);
        const latest = layouts
          .filter((event) => event.semanticWindowId === "window.test.one")
          .at(-1);
        expect(latest?.zoomed).toBe(kind === "zoom");
        expect(latest?.panes.find((pane) => pane.semanticPaneId === "pane.alpha")?.width).toBe(
          kind === "zoom" ? 200 : 150,
        );
      } finally {
        await subscription.close();
        await rig.channel.dispose();
      }
    },
  );

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

  it.each(["resize", "membership-aba", "zoom-aba", "malformed"])(
    "distinguishes %s notifications from identity stability during inventory reads",
    async (change) => {
      const descriptorReply = { manual: false };
      const { channel, sim, state } = await startedRig({ descriptorReply, borderReply: "manual" });
      state.descriptorRows[2] = state.descriptorRows[2]!.replace(
        "%3\t\t",
        "%3\tpane.mirror.gen1\t",
      ).replace("\t\tzz-sim", "\twindow.test.two\tzz-sim");
      const descriptorQueries = () =>
        sim.written.filter((cmd) => cmd.includes("qa:@tmux_ide_pane_id")).length;
      const before = descriptorQueries();
      descriptorReply.manual = true;
      const inventory = channel.describeTrustedInventory("$1");
      let settled = false;
      const outcome = inventory
        .then(
          (value) => ({ value }),
          (error) => ({ error }),
        )
        .finally(() => {
          settled = true;
        });
      try {
        for (let index = 0; index < 4; index++) {
          await vi.waitFor(() =>
            expect(settled || descriptorQueries() === before + index + 1).toBe(true),
          );
          if (settled) break;
          const original = FIXTURE.layoutW2;
          const changed = change === "membership-aba" ? "cccc,180x40,0,0,4" : "cccc,180x40,0,0,3";
          if (change === "malformed") {
            sim.feedLines("%layout-change malformed");
          } else {
            sim.feedLines(
              `%layout-change @2 ${changed} ${changed} ${change === "zoom-aba" ? "Z" : "*"}`,
            );
            sim.feedLines(`%layout-change @2 ${original} ${original} *`);
          }
          // Reply in native command order: inventory, then the border queries.
          sim.reply(state.descriptorRows);
          if (change !== "malformed") {
            sim.reply(["off"]);
            sim.reply(["off"]);
          }
        }
        if (change === "resize") {
          expect(await outcome).toMatchObject({ value: { runtimeSessionId: "$1" } });
        } else {
          expect(await outcome).toMatchObject({
            error: expect.objectContaining({ message: expect.stringMatching(/did not settle/u) }),
          });
        }
      } finally {
        await channel.dispose();
      }
    },
  );

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

describe("seed recipe (the observed-pause seam)", () => {
  it("discards pre-pause output, holds overtaking output, and emits one atomic batch", async () => {
    const rig = await startedRig();
    const { channel, sim } = rig;
    const alpha = collect();
    channel.subscribePane("pane.alpha", alpha.onEvent);
    expect(sim.written.some((cmd) => cmd.includes("capture-pane"))).toBe(false);
    sim.output("%1", "PRE");
    expect(bytesOf(alpha.events)).toEqual([]);
    completeStockPause(rig, "%1");
    sim.output("%1", "MID");
    completeAtomicRecoveryPhase(rig, ["CAPTURED:PRE"], "4 9 100 50", { continueNotify: true });
    const content = alpha.events.filter((event) => event.type !== "flow");
    expect(content.map((event) => event.type)).toEqual(["reset", "seed", "cursor", "delta"]);
    expect(content[0]).toEqual({ type: "reset", cols: 100, rows: 50 });
    expect(bytesOf(content)).toEqual(["CAPTURED:PRE", "MID"]);
    expect(content[2]).toEqual({ type: "cursor", x: 4, y: 9 });
    sim.output("%1", "POST");
    expect(bytesOf(alpha.events).at(-1)).toBe("POST");
    await channel.dispose();
  });

  it("routes bytes only to the pane's own subscribers", async () => {
    const rig = await startedRig();
    const { channel, sim } = rig;
    const alpha = collect();
    const beta = collect();
    channel.subscribePane("pane.alpha", alpha.onEvent);
    completeSeed(rig, ["seed-a"], "0 0 100 50");
    channel.subscribePane("pane.beta", beta.onEvent);
    completeSeed(rig, ["seed-b"], "0 0 99 50");
    sim.output("%1", "FOR-ALPHA");
    sim.output("%2", "FOR-BETA");
    expect(bytesOf(alpha.events)).toEqual(["seed-a", "FOR-ALPHA"]);
    expect(bytesOf(beta.events)).toEqual(["seed-b", "FOR-BETA"]);
    await channel.dispose();
  });
});

describe("stock observed-pause snapshot", () => {
  it("seeds initial subscribers once and places captured cursor before overtaking output", async () => {
    const rig = await startedRig({ atomicHook: true });
    const alpha = collect();
    try {
      rig.channel.subscribePane("pane.alpha", alpha.onEvent);
      rig.sim.output("%1", "BEFORE-PAUSE");
      expect(bytesOf(alpha.events)).toEqual([]);
      completeStockPause(rig, "%1");
      // Real stock control mode can deliver these bytes before every snapshot
      // guard. The observed pause, not the capture reply, is their lower fence.
      rig.sim.output("%1", "AFTER-CAPTURE");
      expect(bytesOf(alpha.events)).toEqual([]);
      completeAtomicRecoveryPhase(rig, ["CAPTURE"], "3 2 100 50", {
        continueNotify: true,
      });
      expect(bytesOf(alpha.events)).toEqual(["CAPTURE", "AFTER-CAPTURE"]);
      const cursor = alpha.events.findIndex((event) => event.type === "cursor");
      const delta = alpha.events.findIndex((event) => event.type === "delta");
      expect(cursor).toBeGreaterThanOrEqual(0);
      expect(delta).toBeGreaterThan(cursor);
      expect(alpha.events.filter((event) => event.type === "seed")).toHaveLength(1);
      rig.sim.output("%1", "LIVE");
      expect(bytesOf(alpha.events)).toEqual(["CAPTURE", "AFTER-CAPTURE", "LIVE"]);
    } finally {
      await rig.channel.dispose();
    }
  });

  it("reseeds every existing viewer when another viewer joins the same paused pane", async () => {
    const rig = await startedRig({ atomicHook: true });
    const first = collect();
    const second = collect();
    try {
      rig.channel.subscribePane("pane.alpha", first.onEvent);
      completeStockPause(rig, "%1");
      completeAtomicRecoveryPhase(rig, ["FIRST"], "5 0 100 50", { continueNotify: true });
      first.events.length = 0;
      rig.channel.subscribePane("pane.alpha", second.onEvent);
      completeStockPause(rig, "%1");
      rig.sim.output("%1", "SHARED-TAIL");
      completeAtomicRecoveryPhase(rig, ["SHARED"], "6 0 100 50", { continueNotify: true });
      expect(bytesOf(first.events)).toEqual(["SHARED", "SHARED-TAIL"]);
      expect(bytesOf(second.events)).toEqual(["SHARED", "SHARED-TAIL"]);
      rig.sim.output("%1", "LIVE");
      expect(bytesOf(first.events).at(-1)).toBe("LIVE");
      expect(bytesOf(second.events).at(-1)).toBe("LIVE");
    } finally {
      await rig.channel.dispose();
    }
  });

  it("fails within its deadline rather than publishing a truncated postpause tail", async () => {
    const rig = await startedRig({ atomicHook: true });
    const alpha = collect();
    try {
      rig.channel.subscribePane("pane.alpha", alpha.onEvent);
      completeStockPause(rig, "%1");
      const chunk = "X".repeat(16 * 1024);
      for (let index = 0; index < 65; index++) rig.sim.output("%1", chunk);
      expect(bytesOf(alpha.events)).toEqual([]);
      advanceRecoveryClock(rig, 5_001);
      expect(bytesOf(alpha.events)).toEqual([]);
      expect(alpha.events.some((event) => event.type === "fault")).toBe(true);
    } finally {
      await rig.channel.dispose();
    }
  });

  it("invalidates a buffered tail when tmux pauses again before snapshot completion", async () => {
    const rig = await startedRig({ atomicHook: true });
    const alpha = collect();
    try {
      rig.channel.subscribePane("pane.alpha", alpha.onEvent);
      completeStockPause(rig, "%1");
      rig.sim.output("%1", "TAIL-BEFORE-SECOND-GAP");
      rig.sim.feedLines("%pause %1");
      expect(bytesOf(alpha.events)).toEqual([]);
      // No successful fresh snapshot arrives. The obsolete tail must never
      // escape, and repeated recovery must not extend the original deadline.
      advanceRecoveryClock(rig, 5_001);
      expect(bytesOf(alpha.events)).toEqual([]);
      expect(alpha.events.some((event) => event.type === "fault")).toBe(true);
    } finally {
      await rig.channel.dispose();
    }
  });

  it("keeps a second pane queued until the first snapshot collector drains", async () => {
    const rig = await startedRig({ atomicHook: true });
    const first = collect();
    const second = collect();
    const betaSnapshotInstalled = () =>
      rig.sim.written.some((command) =>
        command.startsWith("set-option -po -t %2 @tmux_ide_atomic_expected_"),
      );
    try {
      rig.channel.subscribePane("pane.alpha", first.onEvent);
      completeStockPause(rig, "%1");
      rig.channel.subscribePane("pane.beta", second.onEvent);
      expect(betaSnapshotInstalled()).toBe(false);
      completeAtomicRecoveryPhase(rig, ["ALPHA"], "5 0 100 50", { continueNotify: true });
      completeStockPause(rig, "%2");
      expect(betaSnapshotInstalled()).toBe(true);
      completeAtomicRecoveryPhase(rig, ["BETA"], "4 0 99 50", {
        continueNotify: true,
        runtimePaneId: "%2",
      });
      expect(bytesOf(first.events)).toEqual(["ALPHA"]);
      expect(bytesOf(second.events)).toEqual(["BETA"]);
    } finally {
      await rig.channel.dispose();
    }
  });

  it("does not admit queued pane B until cancelled pane A's actual fence reply drains", async () => {
    const rig = await startedRig({ atomicHook: true });
    const first = collect();
    const second = collect();
    const betaSnapshotInstalled = () =>
      rig.sim.written.some((command) =>
        command.startsWith("set-option -po -t %2 @tmux_ide_atomic_expected_"),
      );
    try {
      const handle = rig.channel.subscribePane("pane.alpha", first.onEvent);
      completeStockPause(rig, "%1");
      const install = rig.sim.written.find((command) =>
        command.includes("@tmux_ide_atomic_owner_"),
      )!;
      const nonce = /@tmux_ide_atomic_owner_([0-9a-f]{32,128})/u.exec(install)![1]!;
      rig.channel.subscribePane("pane.beta", second.onEvent);
      handle.close();
      expect(betaSnapshotInstalled()).toBe(false);
      drainRetiredAtomicCollector(rig, nonce);
      completeStockPause(rig, "%2");
      completeAtomicRecoveryPhase(rig, ["BETA"], "4 0 99 50", {
        continueNotify: true,
        runtimePaneId: "%2",
      });
      expect(bytesOf(first.events)).toEqual([]);
      expect(bytesOf(second.events)).toEqual(["BETA"]);
    } finally {
      await rig.channel.dispose();
    }
  });

  it("keeps native -Q behind the same admission lease as a stock snapshot", async () => {
    const adapter = {
      bindIo: vi.fn(),
      dispose: vi.fn(),
      atomicSnapshotEpoch: vi.fn((_io: unknown, representation: string) =>
        representation === "native" ? "11111111-1111-4111-8111-111111111111" : null,
      ),
      tryDispatch: vi.fn<NonNullable<SessionChannelOptions["ownedViewer"]>["tryDispatch"]>(
        (_io, request) => request.commands[0]?.includes("-Q") ?? false,
      ),
    };
    const rig = await startedRig({ atomicHook: true, ownedViewer: adapter, nativeBirth: "11" });
    try {
      rig.channel.subscribePane("pane.alpha", () => {});
      completeStockPause(rig, "%1");
      rig.channel.subscribePane("pane.beta", () => {}, undefined, true);
      expect(
        adapter.tryDispatch.mock.calls.filter(([, request]) => request.commands[0]?.includes("-Q")),
      ).toHaveLength(0);
      completeAtomicRecoveryPhase(rig, ["ALPHA"], "5 0 100 50", { continueNotify: true });
      const native = adapter.tryDispatch.mock.calls.filter(([, request]) =>
        request.commands[0]?.includes("-Q"),
      );
      expect(native).toHaveLength(1);
      expect(native[0]![1]).toMatchObject({ paneId: "%2", paneBirthId: "11" });
      expect(native[0]![1].commands[0]).not.toContain("-D");
    } finally {
      await rig.channel.dispose();
    }
  });

  it("restarts for a subscriber joining during capture without publishing the old batch", async () => {
    const rig = await startedRig({ atomicHook: true });
    const first = collect();
    const second = collect();
    try {
      rig.channel.subscribePane("pane.alpha", first.onEvent);
      completeStockPause(rig, "%1");
      const collector = rig.armedAtomicCollectors.at(-1)!;
      rig.sim.output("%1", "OLD-TAIL");
      rig.channel.subscribePane("pane.alpha", second.onEvent);
      expect(bytesOf(first.events)).toEqual([]);
      expect(bytesOf(second.events)).toEqual([]);
      drainRetiredAtomicCollector(rig, collector.nonce);
      completeStockPause(rig, "%1", false);
      rig.sim.output("%1", "NEW-TAIL");
      completeAtomicRecoveryPhase(rig, ["NEW"], "3 0 100 50", { continueNotify: true });
      expect(bytesOf(first.events)).toEqual(["NEW", "NEW-TAIL"]);
      expect(bytesOf(second.events)).toEqual(["NEW", "NEW-TAIL"]);
    } finally {
      await rig.channel.dispose();
    }
  });

  it("does not arm or invoke a pause hook after cancellation during option setup", async () => {
    const rig = await startedRig({ manualAfterPauseSetup: true });
    const alpha = collect();
    try {
      const handle = rig.channel.subscribePane("pane.alpha", alpha.onEvent);
      expect(rig.sim.written.at(-1)).toContain("@tmux_ide_pause_");
      expect(rig.armedAtomicCollectors).toEqual([]);
      handle.close();
      // The option command really finishes after cancellation. Its stale reply
      // must not install a collector or invoke the hook on an unobserved pane.
      rig.sim.reply([]);
      expect(rig.armedAtomicCollectors).toEqual([]);
      expect(rig.sim.written.some((command) => command.includes("set-hook -Rp"))).toBe(false);
      expect(bytesOf(alpha.events)).toEqual([]);
    } finally {
      await rig.channel.dispose();
    }
  });

  it("does not dispatch queued recovery after the owning control channel exits", async () => {
    const rig = await startedRig();
    const alpha = collect();
    const beta = collect();
    try {
      rig.channel.subscribePane("pane.alpha", alpha.onEvent);
      completeStockPause(rig, "%1");
      rig.channel.subscribePane("pane.beta", beta.onEvent);
      const count = rig.armedAtomicCollectors.length;
      rig.sim.feedLines("%exit test channel exit");
      advanceRecoveryClock(rig, 10_000);
      expect(rig.armedAtomicCollectors).toHaveLength(count);
      expect(bytesOf(alpha.events)).toEqual([]);
      expect(bytesOf(beta.events)).toEqual([]);
      expect(rig.pendingRecoveries.filter((task) => !task.cancelled)).toEqual([]);
    } finally {
      await rig.channel.dispose();
    }
  });

  it("never publishes a paused snapshot after its final subscriber closes", async () => {
    const rig = await startedRig({ atomicHook: true });
    const alpha = collect();
    try {
      const handle = rig.channel.subscribePane("pane.alpha", alpha.onEvent);
      completeStockPause(rig, "%1");
      rig.sim.output("%1", "HELD");
      const nonce = rig.armedAtomicCollectors.at(-1)!.nonce;
      handle.close();
      rig.sim.output("%1", "LATE");
      expect(bytesOf(alpha.events)).toEqual([]);
      expect(rig.sim.written.at(-1)).not.toBe("refresh-client -A '%1:continue'");
      drainRetiredAtomicCollector(rig, nonce);
      expect(rig.sim.written).toContain("refresh-client -A '%1:continue'");
    } finally {
      await rig.channel.dispose();
    }
  });
});

describe("flow control", () => {
  // Recovery now has one authenticated pause/snapshot transaction. Tests below
  // exercise its public guarantees instead of the removed quiet/confirm passes.
  it("gives queued panes fresh budgets and coalesces same-pane viewers", async () => {
    const rig = await startedRig();
    const a = collect(),
      b = collect(),
      joined = collect();
    try {
      rig.channel.subscribePane("pane.alpha", a.onEvent);
      completeStockPause(rig, "%1");
      const old = rig.armedAtomicCollectors.at(-1)!;
      rig.channel.subscribePane("pane.beta", b.onEvent);
      rig.channel.subscribePane("pane.alpha", joined.onEvent);
      rig.sim.output("%2", "included-in-seed");
      expect(b.events).toEqual([]);
      drainRetiredAtomicCollector(rig, old.nonce);
      advanceRecoveryClock(rig, 400);
      completeSeed(rig, ["beta"], "0 0 99 50");
      advanceRecoveryClock(rig, 400);
      completeSeed(rig, ["shared"], "0 0 100 50");
      expect(bytesOf(a.events)).toEqual(["shared"]);
      expect(bytesOf(joined.events)).toEqual(["shared"]);
      expect(bytesOf(b.events)).toEqual(["beta"]);
    } finally {
      await rig.channel.dispose();
    }
  });

  it.each(["freeze", "close"] as const)(
    "cancels queued %s without disturbing the admitted pane",
    async (operation) => {
      const rig = await startedRig();
      const a = collect(),
        b = collect();
      try {
        rig.channel.subscribePane("pane.alpha", a.onEvent);
        const queued = rig.channel.subscribePane("pane.beta", b.onEvent);
        queued[operation]();
        b.events.length = 0;
        completeSeed(rig, ["alpha"], "0 0 100 50");
        expect(bytesOf(a.events)).toEqual(["alpha"]);
        expect(b.events).toEqual([]);
        expect(rig.armedAtomicCollectors.filter((c) => c.kind !== "pause")).toHaveLength(1);
      } finally {
        await rig.channel.dispose();
      }
    },
  );

  it("does not expire a third pane while earlier panes consume their own command budgets", async () => {
    const rig = await startedRig();
    const lanes = [collect(), collect(), collect()];
    try {
      ["pane.alpha", "pane.beta", "pane.mirror.gen1"].forEach((id, i) =>
        rig.channel.subscribePane(id, lanes[i]!.onEvent),
      );
      for (let i = 0; i < 3; i++) {
        advanceRecoveryClock(rig, 400);
        completeSeed(rig, [`seed${i}`], `0 0 ${[100, 99, 200][i]} 50`);
        expect(bytesOf(lanes[i]!.events)).toEqual([`seed${i}`]);
      }
      expect(lanes.flatMap((l) => l.events).some((e) => e.type === "fault")).toBe(false);
    } finally {
      await rig.channel.dispose();
    }
  });

  it("coalesces queued viewers and cancels all leases and timers on disposal", async () => {
    const rig = await startedRig();
    rig.channel.subscribePane("pane.alpha", () => {});
    for (let i = 0; i < 65; i++) rig.channel.subscribePane("pane.beta", () => {});
    expect(
      (rig.channel as unknown as { snapshotQueue: Map<string, unknown> }).snapshotQueue.size,
    ).toBe(1);
    await rig.channel.dispose();
    expect(
      (rig.channel as unknown as { snapshotQueue: Map<string, unknown> }).snapshotQueue.size,
    ).toBe(0);
    expect(rig.pendingRecoveries.filter((t) => !t.cancelled)).toEqual([]);
  });

  it("fails a silent capture once without faulting frozen or sibling viewers", async () => {
    const rig = await startedRig({
      onFlowRecoveryObserved: (o) => {
        if (o.phase === "nonconverged") throw new Error("sink");
      },
    });
    const a = collect(),
      frozen = collect(),
      b = collect();
    try {
      rig.channel.subscribePane("pane.alpha", a.onEvent);
      completeSeed(rig, ["a"], "0 0 100 50");
      const parked = rig.channel.subscribePane("pane.alpha", frozen.onEvent);
      completeSeed(rig, ["a"], "0 0 100 50");
      parked.freeze();
      rig.channel.subscribePane("pane.beta", b.onEvent);
      completeSeed(rig, ["b"], "0 0 99 50");
      a.events.length = frozen.events.length = b.events.length = 0;
      rig.sim.feedLines("%pause %1");
      completeStockPause(rig, "%1");
      advanceRecoveryClock(rig, 3000);
      expect(a.events.filter((e) => e.type === "fault")).toHaveLength(1);
      expect(frozen.events).toEqual([]);
      expect(b.events).toEqual([]);
      rig.sim.output("%2", "LIVE");
      expect(bytesOf(b.events)).toEqual(["LIVE"]);
      advanceRecoveryClock(rig, 10000);
      expect(a.events.filter((e) => e.type === "fault")).toHaveLength(1);
      expect(bytesOf(a.events)).toEqual([]);
    } finally {
      await rig.channel.dispose();
    }
  });

  it.each(["freeze", "close", "dispose"] as const)(
    "cancels a silent raw capture on %s and rejects late publication",
    async (operation) => {
      const rig = await startedRig();
      const a = collect();
      const handle = rig.channel.subscribePane("pane.alpha", a.onEvent);
      completeStockPause(rig, "%1");
      const old = rig.armedAtomicCollectors.at(-1)!;
      if (operation === "dispose") await rig.channel.dispose();
      else handle[operation]();
      const count = a.events.length;
      rig.sim.feedLines(
        "%begin 1 800 0",
        `%tmux-ide-atomic-v1 ${old.nonce} start`,
        "%end 1 800 0",
        "%begin 1 801 0",
        "LATE",
        "%end 1 801 0",
      );
      expect(bytesOf(a.events)).toEqual([]);
      expect(a.events).toHaveLength(count);
      await rig.channel.dispose();
      expect(rig.pendingRecoveries.filter((t) => !t.cancelled)).toEqual([]);
    },
  );

  it("keeps an unwatched paused pane parked and seeds it when a viewer joins", async () => {
    const rig = await startedRig();
    const a = collect();
    try {
      rig.sim.feedLines("%pause %1");
      expect(rig.armedAtomicCollectors).toEqual([]);
      rig.channel.subscribePane("pane.alpha", a.onEvent);
      completeSeed(rig, ["current"], "0 0 100 50");
      expect(bytesOf(a.events)).toEqual(["current"]);
      expect(rig.channel.flowSnapshot().backpressured).toEqual([]);
    } finally {
      await rig.channel.dispose();
    }
  });

  it("freezes one pane while its sibling flows and thaws through a new shared snapshot", async () => {
    const rig = await startedRig();
    const a = collect(),
      b = collect();
    try {
      rig.channel.subscribePane("pane.alpha", a.onEvent);
      completeSeed(rig, ["a"], "0 0 100 50");
      const handle = rig.channel.subscribePane("pane.beta", b.onEvent);
      completeSeed(rig, ["b"], "0 0 99 50");
      a.events.length = b.events.length = 0;
      handle.freeze();
      rig.sim.output("%2", "FROZEN");
      rig.sim.output("%1", "LIVE");
      expect(bytesOf(b.events)).toEqual([]);
      expect(bytesOf(a.events)).toEqual(["LIVE"]);
      handle.thaw();
      completeSeed(rig, ["fresh"], "0 0 99 50");
      expect(bytesOf(b.events)).toEqual(["fresh"]);
      expect(b.events.filter((e) => e.type === "flow")).toEqual([
        { type: "flow", state: "paused", reason: "requested" },
        { type: "flow", state: "resumed", reason: "requested" },
      ]);
    } finally {
      await rig.channel.dispose();
    }
  });

  it("returns the requested pause when the last frozen subscriber departs", async () => {
    const rig = await startedRig();
    const h = rig.channel.subscribePane("pane.alpha", () => {});
    completeSeed(rig, ["a"], "0 0 100 50");
    h.freeze();
    h.close();
    expect(rig.sim.written).toContain("refresh-client -A '%1:continue'");
    expect(rig.channel.flowSnapshot()).toEqual({ backpressured: [], requested: [] });
    await rig.channel.dispose();
  });

  it.each([true, false])(
    "publishes one authenticated snapshot with inline continue=%s and replays held bytes once",
    async (continueNotify) => {
      const rig = await startedRig();
      const a = collect();
      try {
        rig.channel.subscribePane("pane.alpha", a.onEvent);
        completeSeed(rig, ["old"], "0 0 100 50");
        a.events.length = 0;
        rig.sim.feedLines("%pause %1", "%continue %1");
        expect(bytesOf(a.events)).toEqual([]);
        completeStockPause(rig, "%1");
        rig.sim.output("%1", "TAIL");
        completeAtomicRecoveryPhase(rig, ["SNAPSHOT"], "0 0 100 50", { continueNotify });
        expect(bytesOf(a.events)).toEqual(["SNAPSHOT", "TAIL"]);
        expect(
          a.events
            .map((e) => e.type)
            .filter((t) => ["reset", "seed", "cursor", "delta"].includes(t)),
        ).toEqual(["reset", "seed", "cursor", "delta"]);
        const count = rig.armedAtomicCollectors.length;
        advanceRecoveryClock(rig, 10000);
        expect(rig.armedAtomicCollectors).toHaveLength(count);
      } finally {
        await rig.channel.dispose();
      }
    },
  );

  it("keeps a 5k-row capture alive through >3s authenticated progress without confirmation passes", async () => {
    const observations: MirrorFlowRecoveryObservation[] = [];
    const rig = await startedRig({
      historyLines: 5000,
      onFlowRecoveryObserved: (o) => observations.push(o),
    });
    const a = collect();
    try {
      rig.channel.subscribePane("pane.alpha", a.onEvent);
      completeStockPause(rig, "%1");
      const rows = Array.from({ length: 5000 }, (_, i) => `${i}:${"A".repeat(150)}`);
      completeAtomicRecoveryPhase(rig, rows, "38 39 100 50", { guardDelayMs: 260 });
      expect(rig.recoveryClock.nowMs).toBeGreaterThan(3000);
      expect(rig.recoveryClock.nowMs).toBeLessThan(5000);
      expect(bytesOf(a.events)).toHaveLength(1);
      expect(observations.at(-1)).toMatchObject({
        phase: "converged",
        collectorCaptureLineCount: 5000,
        collectorLastCompletedOrdinal: 12,
        fingerprintExact: null,
      });
      expect(rig.armedAtomicCollectors.filter((c) => c.kind !== "pause")).toHaveLength(1);
    } finally {
      await rig.channel.dispose();
    }
  });

  it("holds admission after a foreign sentinel until a separate ordinary drain fence", async () => {
    const rig = await startedRig();
    const a = collect(),
      b = collect();
    try {
      rig.channel.subscribePane("pane.alpha", a.onEvent);
      completeStockPause(rig, "%1");
      const old = rig.armedAtomicCollectors.at(-1)!;
      rig.channel.subscribePane("pane.beta", b.onEvent);
      rig.sim.feedLines(
        "%begin 1 901 0",
        `%tmux-ide-atomic-v1 ${old.nonce} start`,
        "%end 1 901 0",
        "%begin 1 902 0",
        `%tmux-ide-atomic-v1 ${"f".repeat(32)} capture-end`,
        "%end 1 902 0",
      );
      // Timer callbacks cannot receive native stdout synchronously. Preserve
      // queued cleanup replies until retirement has installed its tombstone.
      const reply = rig.sim.reply.bind(rig.sim);
      const pending: Array<() => void> = [];
      rig.sim.reply = (lines, ok = true) => {
        pending.push(() => reply(lines, ok));
      };
      advanceRecoveryClock(rig, 3000);
      rig.sim.reply = reply;
      for (const flush of pending) flush();
      expect(a.events.filter((e) => e.type === "fault")).toHaveLength(1);
      expect(b.events).toEqual([]);
      expect(rig.armedAtomicCollectors.at(-1)).toBe(old);
      drainRetiredAtomicCollector(rig, old.nonce);
      completeSeed(rig, ["beta"], "0 0 99 50");
      expect(bytesOf(b.events)).toEqual(["beta"]);
    } finally {
      await rig.channel.dispose();
    }
  });

  it("rejects a hook replaced between create and invoke without deleting that replacement", async () => {
    const rig = await startedRig({ replaceAtomicHookBeforeInvoke: true });
    const a = collect();
    try {
      rig.channel.subscribePane("pane.alpha", a.onEvent);
      completeStockPause(rig, "%1");
      expect(rig.atomicInvocationAuthorizations).toEqual([false]);
      const replacement = [...rig.atomicHookValues.entries()].find(([n]) =>
        /^@tmux_ide_atomic_[0-9a-f]+$/u.test(n),
      );
      expect(replacement?.[1]).toBe("replacement-B");
      expect(bytesOf(a.events)).toEqual([]);
      expect(
        rig.sim.written
          .filter((c) => c.includes("set-option -pu") && c.includes(replacement![0]))
          .every((c) => c.includes("if-shell")),
      ).toBe(true);
    } finally {
      await rig.channel.dispose();
    }
  });

  it.each([
    [7, false],
    [8, true],
    [9, true],
    [10, true],
    [11, true],
    [12, true],
  ] as const)(
    "owns marker redemption when raw command %s fails",
    async (errorOrdinal, redeemable) => {
      const rig = await startedRig();
      const a = collect();
      try {
        rig.channel.subscribePane("pane.alpha", a.onEvent);
        completeStockPause(rig, "%1");
        const marker = completeAtomicRecoveryPhase(rig, ["private"], "0 0 100 50", {
          errorOrdinal,
        });
        expect(consumeInternalReadOperation(marker, "%1", "workspace.pane.read")).toBe(redeemable);
        expect(consumeInternalReadOperation(marker, "%1", "workspace.pane.read")).toBe(false);
        expect(bytesOf(a.events)).toEqual([]);
      } finally {
        await rig.channel.dispose();
      }
    },
  );

  it("bounds repeated invalid cursor snapshots to four attempts and retains a single deadline", async () => {
    const rig = await startedRig();
    const a = collect();
    try {
      rig.channel.subscribePane("pane.alpha", a.onEvent);
      for (let i = 0; i < 4; i++) {
        completeSeed(rig, ["invalid"], "not-a-cursor");
      }
      expect(a.events.filter((e) => e.type === "fault")).toHaveLength(1);
      expect(bytesOf(a.events)).toEqual([]);
      expect(rig.armedAtomicCollectors.filter((c) => c.kind !== "pause")).toHaveLength(4);
      advanceRecoveryClock(rig, 10000);
      expect(a.events.filter((e) => e.type === "fault")).toHaveLength(1);
    } finally {
      await rig.channel.dispose();
    }
  });

  it("absolute deadline wins despite continuing authenticated progress", async () => {
    const rig = await startedRig();
    const a = collect();
    try {
      rig.channel.subscribePane("pane.alpha", a.onEvent);
      completeStockPause(rig, "%1");
      completeAtomicRecoveryPhase(rig, ["private"], "0 0 100 50", { guardDelayMs: 450 });
      expect(a.events.filter((e) => e.type === "fault")).toHaveLength(1);
      expect(bytesOf(a.events)).toEqual([]);
    } finally {
      await rig.channel.dispose();
    }
  });

  it("retries a bounded held-output overflow only after the old collector drains", async () => {
    const rig = await startedRig();
    const a = collect();
    try {
      rig.channel.subscribePane("pane.alpha", a.onEvent);
      completeStockPause(rig, "%1");
      const old = rig.armedAtomicCollectors.at(-1)!;
      for (let i = 0; i < 65; i++) rig.sim.output("%1", "X".repeat(16384));
      expect(bytesOf(a.events)).toEqual([]);
      expect(rig.armedAtomicCollectors.at(-1)).toBe(old);
      drainRetiredAtomicCollector(rig, old.nonce);
      completeSeed(rig, ["fresh"], "0 0 100 50");
      expect(bytesOf(a.events)).toEqual(["fresh"]);
    } finally {
      await rig.channel.dispose();
    }
  });

  it("channel exit closes active and queued viewers and cancels every deadline", async () => {
    const rig = await startedRig();
    const a = collect(),
      b = collect();
    rig.channel.subscribePane("pane.alpha", a.onEvent);
    completeStockPause(rig, "%1");
    rig.channel.subscribePane("pane.beta", b.onEvent);
    rig.sim.feedLines("%exit fixture-end");
    expect(a.events.at(-1)).toEqual({ type: "closed" });
    expect(b.events.at(-1)).toEqual({ type: "closed" });
    expect(rig.pendingRecoveries.filter((t) => !t.cancelled)).toEqual([]);
    expect(
      (rig.channel as unknown as { snapshotQueue: Map<string, unknown> }).snapshotQueue.size,
    ).toBe(0);
    await rig.channel.dispose();
  });
  it("closes restamped subscribers during active raw recovery and seeds only the replacement", async () => {
    const rig = await startedRig();
    const oldEvents = collect();
    try {
      rig.channel.subscribePane("pane.alpha", oldEvents.onEvent);
      completeSeed(rig, ["old seed"], "0 0 100 50");
      oldEvents.events.length = 0;
      rig.sim.feedLines("%pause %1");
      completeStockPause(rig, "%1");
      const old = rig.armedAtomicCollectors.at(-1)!;
      rig.state.descriptorRows[0] = rig.state.descriptorRows[0]!.replace(
        "%1\tpane.alpha\t",
        "%1\tpane.replacement\t",
      );
      rig.sim.feedLines("%window-renamed @1 restamped");
      rig.pendingSyncs.shift()!();
      await vi.waitFor(() => expect(oldEvents.events.at(-1)).toEqual({ type: "closed" }));
      await vi.waitFor(() =>
        expect(
          rig.channel.describe().panes.some((p) => p.semanticPaneId === "pane.replacement"),
        ).toBe(true),
      );
      const count = oldEvents.events.length;
      completeAtomicRecoveryPhase(rig, ["late old snapshot"], "0 0 100 50");
      rig.sim.feedLines("%continue %1");
      rig.sim.output("%1", "replacement output");
      expect(oldEvents.events).toHaveLength(count);
      expect(bytesOf(oldEvents.events)).toEqual([]);
      const fresh = collect();
      rig.channel.subscribePane("pane.replacement", fresh.onEvent);
      expect(fresh.events.some((e) => e.type === "seed")).toBe(false);
      drainRetiredAtomicCollector(rig, old.nonce);
      completeSeed(rig, ["replacement seed"], "0 0 100 50");
      expect(bytesOf(fresh.events)).toEqual(["replacement seed"]);
      expect(oldEvents.events).toHaveLength(count);
    } finally {
      await rig.channel.dispose();
    }
  });
});

describe("layout push", () => {
  it.each([true, false])(
    "recaptures after pending layout admission before publishing a new-size seed to its owner (native=%s)",
    async (nativeBootstrap) => {
      const rig = await startedRig({ borderReply: "manual" });
      const events: MirrorPaneEvent[] = [];
      const observability = createSessionRuntimeObservability();
      const faults: unknown[] = [];
      const mirror = {
        subscribe: async (candidate: MirrorSubscribeRequest) => {
          const handle = rig.channel.subscribePane(
            "pane.alpha",
            (event) => {
              events.push(event);
              candidate.onEvent(event);
            },
            candidate.onLayout,
            nativeBootstrap,
          );
          return { ...handle, session: candidate.session, close: async () => handle.close() };
        },
      };
      const owner = new SessionRuntimeTerminalReplicaOwner(
        "00000000-0000-4000-8000-000000000001",
        FIXTURE.session,
        "pane.alpha",
        mirror as never,
        {
          incarnation: "pending-layout:0",
          initialRevision: 0,
          observability,
          onFault: (error) => faults.push(error),
        },
      );
      const updates: CanonicalTerminalReplicaUpdate[] = [];
      const ready = owner.subscribe((update) => updates.push(update));
      void ready.catch(() => {});
      try {
        await Promise.resolve();
        if (nativeBootstrap) rig.sim.reply(nativeBootstrapLines());
        completeStockPause(rig, "%1");
        const retiredNonce = rig.armedAtomicCollectors.at(-1)!.nonce;
        rig.sim.feedLines(
          `%layout-change @1 ${FIXTURE.layoutW1} aaaa,200x50,0,0{150x50,0,0,1,49x50,151,0,2} 0`,
        );
        const nativeWithText = (text: string) => {
          const lines = nativeBootstrapLines();
          lines[0] = JSON.stringify({
            ...JSON.parse(lines[0]!),
            cols: 150,
            cursor: [text.length, 0],
          });
          lines[1] = JSON.stringify({
            row: 0,
            flags: 0,
            used: text.length,
            cells: [...text].map((c) => [0, 1, Buffer.from(c).toString("hex"), 0, 8, 8, 8, 0, 0]),
          });
          return lines;
        };
        const native = nativeWithText("BEFORE");
        completeAtomicRecoveryPhase(rig, nativeBootstrap ? native : ["BEFORE"], "0 0 150 50", {
          continueNotify: true,
        });
        expect(events).toEqual([]);
        expect(observability.snapshot().spans.filter((span) => span.terminalReseed)).toEqual([]);
        rig.sim.output("%1", "DURING");
        rig.sim.reply(["off"]);
        drainRetiredAtomicCollector(rig, retiredNonce);
        rig.state.windowRows = FIXTURE.windowRows(
          "aaaa,200x50,0,0{150x50,0,0,1,49x50,151,0,2}",
          FIXTURE.layoutW2,
        );
        rig.pendingSyncs.shift()!();
        await vi.waitFor(() => expect(rig.armedAtomicCollectors.at(-1)?.kind).toBe("pause"));
        completeSeed(
          rig,
          nativeBootstrap ? nativeWithText("BEFOREDURING") : ["BEFOREDURING"],
          "11 0 150 50",
        );
        await ready;
        expect(events.map((event) => event.type)).toEqual(["reset", "seed", "cursor", "flow"]);
        expect(updates[0]).toMatchObject({ type: "terminal.seed", cols: 150, rows: 50 });
        const first = updates[0]!;
        expect(
          first.type === "terminal.seed" &&
            first.snapshot.grid[0]!.cells.map((cell) => cell.grapheme)
              .join("")
              .trimEnd(),
        ).toBe("BEFOREDURING");
        rig.sim.output("%1", "AFTER");
        expect(bytesOf(events)).toEqual([nativeBootstrap ? "" : "BEFOREDURING", "AFTER"]);
        expect(faults).toEqual([]);
      } finally {
        await owner.dispose();
        await rig.channel.dispose();
      }
    },
  );

  it("waits for authoritative geometry progress when capture is ahead of every layout notification", async () => {
    const descriptorReply = { manual: false };
    const rig = await startedRig({ descriptorReply });
    const events: MirrorPaneEvent[] = [];
    const observability = createSessionRuntimeObservability();
    const faults: unknown[] = [];
    const mirror = {
      subscribe: async (candidate: MirrorSubscribeRequest) => {
        const handle = rig.channel.subscribePane(
          "pane.alpha",
          (event) => {
            events.push(event);
            candidate.onEvent(event);
          },
          candidate.onLayout,
          true,
        );
        return { ...handle, session: candidate.session, close: async () => handle.close() };
      },
    };
    const owner = new SessionRuntimeTerminalReplicaOwner(
      "00000000-0000-4000-8000-000000000001",
      FIXTURE.session,
      "pane.alpha",
      mirror as never,
      {
        incarnation: "ahead-layout:0",
        initialRevision: 0,
        observability,
        onFault: (error) => faults.push(error),
      },
    );
    const ready = owner.subscribe(() => {});
    void ready.catch(() => {});
    try {
      await Promise.resolve();
      const native = nativeBootstrapLines();
      native[0] = JSON.stringify({ ...JSON.parse(native[0]!), cols: 150 });
      const captures = () =>
        rig.armedAtomicCollectors.filter((collector) => collector.kind === "pause").length;
      const before = captures();
      completeSeed(rig, native, "0 0 150 50");
      await Promise.resolve();
      expect(events).toEqual([]);
      expect(captures()).toBe(before + 1);
      expect(rig.pendingSyncs).toHaveLength(1);
      // No layout notification: an authoritative list-windows response alone
      // provides the missing geometry, under the original capture deadline.
      rig.state.windowRows = FIXTURE.windowRows(
        "aaaa,200x50,0,0{150x50,0,0,1,49x50,151,0,2}",
        FIXTURE.layoutW2,
      );
      rig.pendingSyncs.shift()!();
      await vi.waitFor(() => expect(captures()).toBe(before + 2));
      completeSeed(rig, native, "0 0 150 50");
      await ready;
      expect(events.map((event) => event.type)).toEqual(["reset", "seed", "cursor", "flow"]);
      expect(faults).toEqual([]);
      expect(observability.snapshot().spans.filter((span) => span.terminalReseed)).toEqual([]);
    } finally {
      await owner.dispose();
      await rig.channel.dispose();
    }
  });

  it("recaptures after fresh unchanged truth when a resize returns to the published size", async () => {
    const descriptorReply = { manual: false };
    const rig = await startedRig({ descriptorReply });
    const events = collect();
    try {
      rig.channel.subscribePane("pane.alpha", events.onEvent);
      completeSeed(rig, ["stale enlarged capture"], "0 0 150 50");
      const captures = () =>
        rig.armedAtomicCollectors.filter((collector) => collector.kind === "pause").length;
      expect(captures()).toBe(1);
      expect(events.events).toEqual([]);
      rig.pendingSyncs.shift()!();
      await vi.waitFor(() => expect(captures()).toBe(2));
      completeSeed(rig, ["stable original size"], "0 0 100 50");
      expect(bytesOf(events.events)).toEqual(["stable original size"]);
      expect(rig.pendingRecoveries.filter((task) => !task.cancelled)).toEqual([]);
    } finally {
      await rig.channel.dispose();
    }
  });

  it("does not release on an older in-flight sync and schedules a subsequent fresh barrier", async () => {
    const descriptorReply = { manual: false };
    const rig = await startedRig({ descriptorReply });
    const events = collect();
    try {
      let release!: (lines: string[]) => void;
      vi.spyOn(rig.sim, "request").mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      rig.sim.feedLines("%window-renamed @1 main");
      rig.pendingSyncs.shift()!();
      rig.channel.subscribePane("pane.alpha", events.onEvent);
      completeSeed(rig, ["ahead"], "0 0 150 50");
      const captures = () =>
        rig.armedAtomicCollectors.filter((collector) => collector.kind === "pause").length;
      expect(rig.pendingSyncs).toHaveLength(1);
      const before = rig.sim.written.length;
      release(rig.state.truthRows);
      await vi.waitFor(() => expect(rig.sim.written.length).toBeGreaterThan(before));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(captures()).toBe(1);
      expect(events.events).toEqual([]);
      rig.pendingSyncs.shift()!();
      await vi.waitFor(() => expect(captures()).toBe(2));
      completeSeed(rig, ["after fresh barrier"], "0 0 100 50");
      expect(bytesOf(events.events)).toEqual(["after fresh barrier"]);
    } finally {
      await rig.channel.dispose();
    }
  });

  it("coalesces repeated mismatches behind a fresh sync without extending the deadline", async () => {
    const descriptorReply = { manual: false };
    const rig = await startedRig({ descriptorReply });
    const events = collect();
    try {
      const handle = rig.channel.subscribePane("pane.alpha", events.onEvent);
      completeSeed(rig, ["ahead"], "0 0 150 50");
      const captures = () =>
        rig.armedAtomicCollectors.filter((collector) => collector.kind === "pause").length;
      for (let cycle = 0; cycle < 2; cycle++) {
        for (let request = 0; request < 100; request++) handle.reseed();
        expect(rig.pendingSyncs).toHaveLength(1);
        expect(captures()).toBe(cycle + 1);
        advanceRecoveryClock(rig, 1000);
        rig.pendingSyncs.shift()!();
        await vi.waitFor(() => expect(captures()).toBe(cycle + 2));
        completeSeed(rig, ["still ahead"], "0 0 150 50");
        expect(events.events).toEqual([]);
        expect(
          rig.pendingRecoveries.filter((task) => !task.cancelled).map((task) => task.dueAtMs),
        ).toEqual([5000]);
      }
      advanceRecoveryClock(rig, 3000);
      const before = captures();
      rig.pendingSyncs.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(captures()).toBe(before);
      expect(bytesOf(events.events)).toEqual([]);
    } finally {
      await rig.channel.dispose();
    }
  });

  it("does not qualify failed truth sync or extend the original recovery deadline", async () => {
    const rig = await startedRig();
    const events = collect();
    try {
      rig.channel.subscribePane("pane.alpha", events.onEvent);
      completeSeed(rig, ["ahead"], "0 0 150 50");
      vi.spyOn(rig.sim, "request").mockRejectedValueOnce(new Error("truth unavailable"));
      rig.pendingSyncs.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(
        rig.armedAtomicCollectors.filter((collector) => collector.kind === "pause"),
      ).toHaveLength(1);
      expect(events.events).toEqual([]);
      expect(
        rig.pendingRecoveries.filter((task) => !task.cancelled).map((task) => task.dueAtMs),
      ).toEqual([5000]);
      advanceRecoveryClock(rig, 5000);
      expect(bytesOf(events.events)).toEqual([]);
    } finally {
      await rig.channel.dispose();
    }
  });

  it("uses saved geometry for a hidden zoom pane and waits for saved-layout progress", async () => {
    const rig = await startedRig();
    const events = collect();
    try {
      const visible = "aaaa,200x50,0,0,2";
      rig.sim.feedLines(`%layout-change @1 ${FIXTURE.layoutW1} ${visible} *Z`);
      rig.channel.subscribePane("pane.alpha", events.onEvent);
      completeSeed(rig, ["ahead"], "0 0 150 50");
      expect(events.events).toEqual([]);
      rig.sim.feedLines(
        `%layout-change @1 aaaa,200x50,0,0{150x50,0,0,1,49x50,151,0,2} ${visible} *Z`,
      );
      rig.state.windowRows = FIXTURE.windowRows(visible, FIXTURE.layoutW2);
      rig.state.windowRows[0] = rig.state.windowRows[0]!.replace(
        "\t0\toff",
        "\t1\toff\taaaa,200x50,0,0{150x50,0,0,1,49x50,151,0,2}",
      );
      rig.pendingSyncs.shift()!();
      await vi.waitFor(() => expect(rig.armedAtomicCollectors.at(-1)?.kind).toBe("pause"));
      completeSeed(rig, ["saved current"], "0 0 150 50");
      expect(bytesOf(events.events)).toEqual(["saved current"]);
    } finally {
      await rig.channel.dispose();
    }
  });

  it.each(["top", "bottom"] as const)(
    "waits for content-row progress at a %s pane border",
    async (border) => {
      const rig = await startedRig({ borderReply: "manual" });
      const events = collect();
      try {
        rig.sim.feedLines(`%layout-change @1 ${FIXTURE.layoutW1} ${FIXTURE.layoutW1} 0`);
        rig.sim.reply([border]);
        rig.channel.subscribePane("pane.alpha", events.onEvent);
        completeSeed(rig, ["ahead"], "0 0 100 50"); // Current pane has only49 content rows.
        expect(events.events).toEqual([]);
        rig.sim.feedLines(
          `%layout-change @1 ${FIXTURE.layoutW1} aaaa,200x51,0,0{100x51,0,0,1,99x51,101,0,2} 0`,
        );
        rig.sim.reply([border]);
        rig.state.windowRows = FIXTURE.windowRows(
          "aaaa,200x51,0,0{100x51,0,0,1,99x51,101,0,2}",
          FIXTURE.layoutW2,
        );
        rig.state.windowRows[0] = rig.state.windowRows[0]!.replace("\toff", `\t${border}`);
        rig.pendingSyncs.shift()!();
        await vi.waitFor(() => expect(rig.armedAtomicCollectors.at(-1)?.kind).toBe("pause"));
        completeSeed(rig, ["current"], "0 0 100 50");
        expect(bytesOf(events.events)).toEqual(["current"]);
      } finally {
        await rig.channel.dispose();
      }
    },
  );

  it("keeps native/probe corruption on the owner's fail-closed path instead of a layout wait", async () => {
    const rig = await startedRig();
    const faults: unknown[] = [];
    const observability = createSessionRuntimeObservability();
    const mirror = {
      subscribe: async (candidate: MirrorSubscribeRequest) => {
        const handle = rig.channel.subscribePane(
          "pane.alpha",
          candidate.onEvent,
          candidate.onLayout,
          true,
        );
        return { ...handle, session: candidate.session, close: async () => handle.close() };
      },
    };
    const owner = new SessionRuntimeTerminalReplicaOwner(
      "00000000-0000-4000-8000-000000000001",
      FIXTURE.session,
      "pane.alpha",
      mirror as never,
      {
        incarnation: "corrupt:0",
        initialRevision: 0,
        observability,
        onFault: (error) => faults.push(error),
      },
    );
    const ready = owner.subscribe(() => {});
    void ready.catch(() => {});
    try {
      await Promise.resolve();
      for (let i = 0; i < 4; i++) {
        completeSeed(rig, nativeBootstrapLines(), "0 0 150 50");
        await Promise.resolve();
      }
      await expect(ready).rejects.toThrow(/native-recovery-failed|upstream|terminal/);
      expect(rig.pendingSyncs).toEqual([]);
      expect(faults).toHaveLength(1);
      expect(
        observability
          .snapshot()
          .spans.filter((span) => span.terminalReseed)
          .map((span) => span.terminalReseed!.reason),
      ).toEqual([]);
    } finally {
      await owner.dispose();
      await rig.channel.dispose();
    }
  });

  async function beginPendingLayout(
    rig: Rig,
    events: ReturnType<typeof collect>,
    onLayout?: () => void,
  ) {
    const handle = rig.channel.subscribePane("pane.alpha", events.onEvent, onLayout, true);
    rig.sim.reply(nativeBootstrapLines());
    completeStockPause(rig, "%1");
    const old = rig.armedAtomicCollectors.at(-1)!;
    rig.sim.feedLines(`%layout-change @1 ${FIXTURE.layoutW1} ${FIXTURE.layoutW1} 0`);
    completeAtomicRecoveryPhase(rig, nativeBootstrapLines(), "0 0 100 50");
    expect(events.events.some((e) => e.type === "seed")).toBe(false);
    return { handle, old };
  }

  it("coalesces superseded layout replies and reentrant reseed requests under the original deadline", async () => {
    const rig = await startedRig({ borderReply: "manual" });
    const events = collect();
    let handle: ReturnType<SessionChannel["subscribePane"]> | undefined;
    let reseedOnLayout = true;
    try {
      const pending = await beginPendingLayout(rig, events, () => {
        if (reseedOnLayout) handle?.reseed();
      });
      handle = pending.handle;
      for (let i = 0; i < 100; i++) handle.reseed();
      advanceRecoveryClock(rig, 4000);
      rig.sim.feedLines(`%layout-change @1 ${FIXTURE.layoutW1} ${FIXTURE.layoutW1} 0`);
      rig.sim.reply(["off"]); // stale metadata cannot release this attempt
      expect(rig.armedAtomicCollectors.at(-1)).toBe(pending.old);
      rig.sim.reply(["off"]);
      drainRetiredAtomicCollector(rig, pending.old.nonce);
      expect(rig.pendingRecoveries.filter((t) => !t.cancelled).map((t) => t.dueAtMs)).toEqual([
        5000,
      ]);
      reseedOnLayout = false;
      rig.pendingSyncs.shift()!();
      await vi.waitFor(() => expect(rig.armedAtomicCollectors.at(-1)?.kind).toBe("pause"));
      completeSeed(rig, nativeBootstrapLines(), "0 0 100 50");
      expect(events.events.filter((e) => e.type === "seed")).toHaveLength(1);
      expect(rig.pendingRecoveries.filter((t) => !t.cancelled)).toEqual([]);
    } finally {
      await rig.channel.dispose();
    }
  });

  it("does not extend the deadline across another layout crossing during replacement capture", async () => {
    const rig = await startedRig({ borderReply: "manual" });
    const events = collect();
    try {
      const { old } = await beginPendingLayout(rig, events);
      advanceRecoveryClock(rig, 4000);
      rig.sim.reply(["off"]);
      drainRetiredAtomicCollector(rig, old.nonce);
      rig.pendingSyncs.shift()!();
      await vi.waitFor(() => expect(rig.armedAtomicCollectors.at(-1)?.kind).toBe("pause"));
      completeStockPause(rig, "%1");
      const replacement = rig.armedAtomicCollectors.at(-1)!;
      rig.sim.feedLines(`%layout-change @1 ${FIXTURE.layoutW1} ${FIXTURE.layoutW1} 0`);
      completeAtomicRecoveryPhase(rig, nativeBootstrapLines(), "0 0 100 50");
      expect(rig.pendingRecoveries.filter((t) => !t.cancelled).map((t) => t.dueAtMs)).toEqual([
        5000,
      ]);
      advanceRecoveryClock(rig, 1000);
      rig.sim.reply(["off"]);
      drainRetiredAtomicCollector(rig, replacement.nonce);
      expect(events.events.some((e) => e.type === "seed")).toBe(false);
      expect(events.events.filter((e) => e.type === "fault")).toHaveLength(1);
    } finally {
      await rig.channel.dispose();
    }
  });

  it("honors reentrant closure during layout admission before resuming capture", async () => {
    const rig = await startedRig({ borderReply: "manual" });
    const events = collect();
    let handle: ReturnType<SessionChannel["subscribePane"]> | undefined;
    try {
      const pending = await beginPendingLayout(rig, events, () => handle?.close());
      handle = pending.handle;
      const count = rig.armedAtomicCollectors.length;
      rig.sim.reply(["off"]);
      drainRetiredAtomicCollector(rig, pending.old.nonce);
      for (const sync of rig.pendingSyncs.splice(0)) sync();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(rig.armedAtomicCollectors).toHaveLength(count);
      expect(events.events.some((e) => e.type === "seed")).toBe(false);
      expect(rig.pendingRecoveries.filter((t) => !t.cancelled)).toEqual([]);
    } finally {
      await rig.channel.dispose();
    }
  });

  it("discards obsolete output while layout admission is blocked and replaces it with one snapshot", async () => {
    const rig = await startedRig({ borderReply: "manual" });
    const events = collect();
    try {
      const { old } = await beginPendingLayout(rig, events);
      for (let i = 0; i < 1025; i++) rig.sim.output("%1", "X".repeat(2048));
      expect(bytesOf(events.events)).toEqual([]);
      rig.sim.reply(["off"]);
      drainRetiredAtomicCollector(rig, old.nonce);
      rig.pendingSyncs.shift()!();
      await vi.waitFor(() => expect(rig.armedAtomicCollectors.at(-1)?.kind).toBe("pause"));
      completeSeed(rig, nativeBootstrapLines(), "0 0 100 50");
      expect(events.events.filter((e) => e.type === "seed")).toHaveLength(1);
      expect(events.events.filter((e) => e.type === "delta")).toEqual([]);
    } finally {
      await rig.channel.dispose();
    }
  });

  it("expires a layout-blocked capture at its original deadline without late restart", async () => {
    const rig = await startedRig({ borderReply: "manual" });
    const events = collect();
    try {
      const { old, handle } = await beginPendingLayout(rig, events);
      advanceRecoveryClock(rig, 4999);
      for (let i = 0; i < 100; i++) handle.reseed();
      expect(rig.pendingRecoveries.filter((t) => !t.cancelled).map((t) => t.dueAtMs)).toEqual([
        5000,
      ]);
      advanceRecoveryClock(rig, 1);
      const count = rig.armedAtomicCollectors.length;
      rig.sim.reply(["off"]);
      drainRetiredAtomicCollector(rig, old.nonce);
      for (const sync of rig.pendingSyncs.splice(0)) sync();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(rig.armedAtomicCollectors).toHaveLength(count);
      expect(events.events.some((e) => e.type === "seed")).toBe(false);
      expect(events.events.filter((e) => e.type === "fault")).toHaveLength(1);
    } finally {
      await rig.channel.dispose();
    }
  });

  it.each(["close", "freeze", "dispose", "replace-subscription"] as const)(
    "retires a pending layout capture on %s before late metadata",
    async (operation) => {
      const rig = await startedRig({ borderReply: "manual" });
      const events = collect(),
        fresh = collect();
      try {
        const { old, handle } = await beginPendingLayout(rig, events);
        if (operation === "replace-subscription")
          rig.channel.subscribePane("pane.alpha", fresh.onEvent, undefined, true);
        if (operation === "dispose") await rig.channel.dispose();
        else if (operation === "freeze") handle.freeze();
        else handle.close();
        rig.sim.reply(["off"]);
        if (operation !== "dispose") drainRetiredAtomicCollector(rig, old.nonce);
        for (const sync of rig.pendingSyncs.splice(0)) sync();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(events.events.some((e) => e.type === "seed")).toBe(false);
        if (operation === "replace-subscription") {
          await vi.waitFor(() => expect(rig.armedAtomicCollectors.at(-1)?.kind).toBe("pause"));
          completeSeed(rig, nativeBootstrapLines(), "0 0 100 50");
          expect(fresh.events.filter((e) => e.type === "seed")).toHaveLength(1);
        } else expect(rig.pendingRecoveries.filter((t) => !t.cancelled)).toEqual([]);
      } finally {
        await rig.channel.dispose();
      }
    },
  );

  it("retains every coherent window while another window is awaiting border metadata", async () => {
    const rig = await startedRig({ borderReply: "manual" });
    rig.state.descriptorRows[2] = rig.state.descriptorRows[2]!.replace(
      "%3\t\t",
      "%3\tpane.mirror.gen1\t",
    ).replace("\t\tzz-sim", "\twindow.test.two\tzz-sim");
    const memberships: number[] = [];
    await rig.channel.subscribeAuthoritativeLayout(
      () => {},
      undefined,
      (snapshot) => memberships.push(snapshot.layouts.length),
    );
    expect(memberships.at(-1)).toBe(2);
    rig.sim.feedLines(`%layout-change @1 ${FIXTURE.layoutW1} ${FIXTURE.layoutW1} 0`);
    rig.sim.feedLines(`%layout-change @2 ${FIXTURE.layoutW2} ${FIXTURE.layoutW2} 0`);
    rig.sim.reply(["off"]);
    expect(memberships.at(-1)).toBe(2);
    rig.sim.reply(["off"]);
    expect(memberships.every((count) => count === 2)).toBe(true);
    await rig.channel.dispose();
  });

  it("holds output until fresh border metadata and ignores superseded replies", async () => {
    const rig = await startedRig({ borderReply: "manual" });
    const events: string[] = [];
    const layouts: MirrorLayoutEvent[] = [];
    rig.channel.subscribePane(
      "pane.alpha",
      (event) => events.push(event.type),
      (layout) => {
        layouts.push(layout);
        events.push("layout");
      },
    );
    completeSeed(rig, ["seed"], "0 0 100 50");
    events.length = 0;
    rig.sim.feedLines(
      `%layout-change @1 ${FIXTURE.layoutW1} aaaa,200x50,0,0{150x50,0,0,1,49x50,151,0,2} 0`,
      "%output %1 a",
    );
    expect(events).toEqual([]);
    rig.sim.feedLines(
      `%layout-change @1 ${FIXTURE.layoutW1} aaaa,200x50,0,0{140x50,0,0,1,59x50,141,0,2} 0`,
      "%output %1 b",
    );
    rig.sim.reply(["off"]);
    expect(events).toEqual([]);
    rig.sim.reply(["top"]);
    expect(events).toEqual(["layout", "delta", "delta"]);
    expect(layouts.at(-1)?.paneBorderStatus).toBe("top");
    expect(layouts.at(-1)?.panes[0]?.width).toBe(140);
    expect(rig.sim.written.filter((cmd) => cmd.includes("tmux-ide-pane-borders:@*")).length).toBe(
      2,
    );
    await rig.channel.dispose();
  });

  it("bounds output held for metadata and recovers instead of replaying a partial stream", async () => {
    const rig = await startedRig({ borderReply: "manual" });
    const collected = collect();
    rig.channel.subscribePane("pane.alpha", collected.onEvent);
    completeSeed(rig, ["seed"], "0 0 100 50");
    collected.events.length = 0;
    rig.sim.feedLines(`%layout-change @1 ${FIXTURE.layoutW1} ${FIXTURE.layoutW1} 0`);
    for (let index = 0; index < 1025; index++) rig.sim.output("%1", "x");
    expect(collected.events).toEqual([]);
    rig.sim.reply(["off"]);
    expect(bytesOf(collected.events)).toEqual([]);
    expect(rig.armedAtomicCollectors.at(-1)).toMatchObject({ kind: "pause", runtimePaneId: "%1" });
    completeSeed(rig, ["complete replacement"], "0 0 100 50");
    expect(bytesOf(collected.events)).toEqual(["complete replacement"]);
    await rig.channel.dispose();
  });

  it("releases held output after an authoritative refresh when the option reply is invalid", async () => {
    const rig = await startedRig({ borderReply: "manual" });
    const collected = collect();
    rig.channel.subscribePane("pane.alpha", collected.onEvent);
    completeSeed(rig, ["seed"], "0 0 100 50");
    collected.events.length = 0;
    rig.sim.feedLines(`%layout-change @1 ${FIXTURE.layoutW1} ${FIXTURE.layoutW1} 0`);
    rig.sim.output("%1", "held");
    rig.sim.reply(["invalid"]);
    expect(bytesOf(collected.events)).toEqual([]);
    expect(rig.pendingSyncs).toHaveLength(1);
    rig.pendingSyncs.shift()!();
    await vi.waitFor(() => expect(bytesOf(collected.events)).toEqual(["held"]));
    await rig.channel.dispose();
  });

  it.each(["awaiting-pause", "awaiting-capture"] as const)(
    "keeps the opening snapshot alive when policy is observed while %s",
    async (phase) => {
      const rig = await startedRig();
      const collected = collect();
      try {
        rig.channel.subscribePane("pane.alpha", collected.onEvent);
        const captures = () =>
          rig.armedAtomicCollectors.filter((collector) => collector.kind === "pause").length;
        const before = captures();
        if (phase === "awaiting-capture") completeStockPause(rig, "%1");
        rig.sim.feedLines(
          "%subscription-changed tmux-ide-scroll-on-clear $1 @1 0 %1 : 1",
          "%subscription-changed tmux-ide-scroll-on-clear $1 @1 0 %1 : 0",
        );
        expect(captures()).toBe(before);
        if (phase === "awaiting-pause") completeStockPause(rig, "%1");
        rig.sim.output("%1", "held-output");
        completeAtomicRecoveryPhase(
          rig,
          ["opening history"],
          "0 0 100 50 0 1 0 0 0 0 0 0 0 1 12 2000 0 0 0 0 0 49 0",
          { continueNotify: true },
        );
        expect(collected.events.filter((event) => event.type === "seed")).toHaveLength(1);
        expect(bytesOf(collected.events)).toEqual(["opening history", "held-output"]);
        const cursor = collected.events.findLast((event) => event.type === "cursor");
        expect(cursor?.type === "cursor" && cursor.observedModes?.scrollOnClear).toBe(false);
        rig.sim.output("%1", "live-output");
        expect(bytesOf(collected.events)).toContain("live-output");
        expect(captures()).toBe(before);
      } finally {
        await rig.channel.dispose();
      }
    },
  );

  it("preserves unavailable tmux 3.4 cursor fields as unknown slots", async () => {
    const rig = await startedRig();
    const collected = collect();
    try {
      rig.channel.subscribePane("pane.alpha", collected.onEvent);
      completeStockPause(rig, "%1");
      const command = rig.sim.written.find((value) => value.includes("#{cursor_x}"));
      expect(command).toContain("#{?#{==:#{bracket_paste_flag},},unknown,#{bracket_paste_flag}}");
      expect(command).toContain("#{?#{==:#{scroll-on-clear},},unknown,#{scroll-on-clear}}");
      // Exact 3.4 observation with its unsupported bracket-paste field retained.
      completeAtomicRecoveryPhase(
        rig,
        ["screen"],
        "0 0 100 50 0 1 0 0 0 0 0 0 0 1 0 2000 unknown 0 0 0 0 49 1",
        { continueNotify: true },
      );
      const cursor = collected.events.findLast((event) => event.type === "cursor");
      expect(cursor?.type).toBe("cursor");
      if (cursor?.type === "cursor") {
        expect(cursor.observedModes).not.toHaveProperty("bracketedPaste");
        expect(cursor.observedModes?.scrollOnClear).toBe(true);
        expect(cursor.observedModes?.scrolling).toEqual({ top: 0, bottom: 49, origin: false });
      }
    } finally {
      await rig.channel.dispose();
    }
  });

  it("reseeds on observed scroll-on-clear changes without guessing unknown policy", async () => {
    const rig = await startedRig();
    const collected = collect();
    rig.channel.subscribePane("pane.alpha", collected.onEvent);
    const probe = (policy: string) =>
      `0 0 100 50 0 1 0 0 0 0 0 0 0 1 12 2000 0 0 0 0 0 49 ${policy}`;
    completeSeed(rig, ["old history"], probe("1"));
    const captures = () =>
      rig.armedAtomicCollectors.filter((collector) => collector.kind === "pause").length;
    const before = captures();
    rig.sim.feedLines("%subscription-changed tmux-ide-scroll-on-clear $1 @1 0 %1 : 1");
    rig.sim.feedLines("%subscription-changed tmux-ide-scroll-on-clear $1 @1 0 %1 : unknown");
    rig.sim.feedLines("%subscription-changed tmux-ide-scroll-on-clear $1 @1 0 %999 : 0");
    expect(captures()).toBe(before);
    rig.sim.feedLines("%subscription-changed tmux-ide-scroll-on-clear $1 @1 0 %1 : 0");
    expect(captures()).toBe(before + 1);
    rig.sim.feedLines("%subscription-changed tmux-ide-scroll-on-clear $1 @1 0 %1 : 0");
    expect(captures()).toBe(before + 1);
    completeSeed(rig, ["updated history"], probe("0"));
    const cursor = collected.events.findLast((event) => event.type === "cursor");
    expect(cursor?.type === "cursor" && cursor.observedModes?.scrollOnClear).toBe(false);
    rig.sim.feedLines("%subscription-changed tmux-ide-scroll-on-clear $1 @1 0 %1 : 1");
    expect(captures()).toBe(before + 2);
    completeSeed(rig, ["restored history"], probe("1"));
    await rig.channel.dispose();
  });

  it("reseeds a watched pane once for a quiet native history clear", async () => {
    const rig = await startedRig();
    const collected = collect();
    rig.channel.subscribePane("pane.alpha", collected.onEvent);
    completeSeed(rig, ["old history"], "0 0 100 50 0 1 0 0 0 0 0 0 0 1 12");
    collected.events.length = 0;
    const captures = () =>
      rig.armedAtomicCollectors.filter((collector) => collector.kind === "pause").length;
    const before = captures();
    rig.sim.feedLines("%subscription-changed tmux-ide-pane-history $1 @1 0 %1 : 0");
    expect(captures()).toBe(before + 1);
    rig.sim.feedLines("%subscription-changed tmux-ide-pane-history $1 @1 0 %1 : 0");
    rig.sim.feedLines("%subscription-changed tmux-ide-pane-history $1 @1 0 %999 : 0");
    expect(captures()).toBe(before + 1);
    completeSeed(rig, ["live grid"], "0 0 100 50 0 1 0 0 0 0 0 0 0 1 0");
    expect(bytesOf(collected.events)).toContain("live grid");
    rig.sim.feedLines("%subscription-changed tmux-ide-pane-history $1 @1 0 %1 : 5");
    expect(captures()).toBe(before + 1);
    await rig.channel.dispose();
  });

  it("publishes native copy key modes and refreshes option-only changes without trusting hints", async () => {
    const rig = await startedRig();
    const layouts: MirrorLayoutEvent[] = [];
    rig.channel.subscribeLayout((event) => layouts.push(event));
    const rows = rig.state.windowRows.map(
      (row, index) =>
        `${row}\t${index === 0 ? FIXTURE.layoutW1 : FIXTURE.layoutW2}\t${index === 0 ? "vi" : "emacs"}`,
    );
    rig.state.windowRows = rows;
    rig.sim.feedLines("%subscription-changed tmux-ide-copy-keys $1 @1 0 - : emacs");
    expect(rig.pendingSyncs).toHaveLength(1);
    rig.pendingSyncs.shift()!();
    await vi.waitFor(() => expect(layouts.at(-2)?.modeKeys).toBe("vi"));
    expect(layouts.at(-1)?.modeKeys).toBe("emacs");
    expect(rig.sim.written).toContain("refresh-client -B 'tmux-ide-copy-keys:@*:#{mode-keys}'");
    const previous = layouts.length;
    rig.state.windowRows = rows.map((row, index) =>
      index === 0 ? row.replace(/vi$/, "emacs") : row,
    );
    rig.sim.feedLines("%subscription-changed tmux-ide-copy-keys $1 @1 0 - : vi");
    rig.sim.feedLines("%subscription-changed tmux-ide-copy-keys $1 @1 0 - : vi");
    expect(rig.pendingSyncs).toHaveLength(1);
    rig.pendingSyncs.shift()!();
    await vi.waitFor(() => expect(layouts.length).toBeGreaterThan(previous));
    expect(
      layouts.findLast((event) => event.semanticWindowId === "window.test.one")?.modeKeys,
    ).toBe("emacs");
    await rig.channel.dispose();
  });

  it("uses the border subscription as a refresh hint even when geometry is unchanged", async () => {
    const rig = await startedRig();
    expect(rig.sim.written).toContain(
      "refresh-client -B 'tmux-ide-pane-borders:@*:#{pane-border-status}'",
    );
    rig.sim.feedLines("%subscription-changed tmux-ide-pane-borders $1 @1 0 - : bottom");
    expect(rig.pendingSyncs).toHaveLength(1);
    rig.sim.feedLines("%subscription-changed tmux-ide-pane-borders $1 @1 0 - : off");
    expect(rig.pendingSyncs).toHaveLength(1);
    await rig.channel.dispose();
  });

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
    completeSeed(rig, ["s"], "0 0 100 50");
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
    completeSeed(rig, ["a"], "0 0 100 50");
    rig.channel.subscribePane(
      "pane.mirror.gen1",
      () => {},
      (event) => gammaLayouts.push(event),
    );
    completeSeed(rig, ["g"], "0 0 200 50");
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
    completeSeed(rig, ["a"], "0 0 100 50");
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
    completeSeed(rig, ["s"], "0 0 99 50");
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
    completeSeed(rig, ["s"], "0 0 100 50");
    // Seed a layout for both windows so each has geometry to re-emit.
    rig.sim.feedLines(`%layout-change @1 ${FIXTURE.layoutW1} ${FIXTURE.layoutW1} 0`);
    rig.sim.feedLines(`%layout-change @2 ${FIXTURE.layoutW2} ${FIXTURE.layoutW2} 0`);
    paneLayouts.length = 0;
    globalLayouts.length = 0;

    rig.state.windowRows = rig.state.windowRows.map((row, index) => {
      const parts = row.split("\t");
      parts[3] = index === 1 ? "1" : "0";
      return parts.join("\t");
    });
    rig.state.truthRows = rig.state.truthRows.map((row) => {
      const parts = row.split("\t");
      parts[3] = parts[2] === "@2" ? "1" : "0";
      return parts.join("\t");
    });
    rig.sim.feedLines("%session-window-changed $1 @2");
    rig.pendingSyncs.shift()!();
    await vi.waitFor(() => expect(globalLayouts.length).toBeGreaterThan(0));

    expect(new Set(paneLayouts.map((event) => event.semanticWindowId))).toEqual(
      new Set(["window.test.one"]),
    );
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
    completeSeed(rig, ["g"], "0 0 200 50");
    gamma.events.length = 0;

    rig.sim.feedLines("%pause %3");
    completeSeed(rig, ["final"], "0 39 200 50");
    expect(bytesOf(gamma.events)).toEqual(["final"]);
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
    rig.sim.output("%3", "after-close");
    expect(gamma.events).toEqual([{ type: "closed" }]);
    await rig.channel.dispose();
  });

  it("schedules a truth sync when a known pane vanishes from a surviving window's layout", async () => {
    const rig = await startedRig();
    const beta = collect();
    rig.channel.subscribePane("pane.beta", beta.onEvent);
    completeSeed(rig, ["b"], "0 0 99 50");
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

describe("window viewport scope", () => {
  it("resolves only session-local semantic windows and clears overrides before global fitting", async () => {
    const rig = await startedRig();
    const before = rig.sim.written.length;
    rig.channel.fitWindowViewport("window.test.one", 120, 40);
    rig.channel.fitWindowViewport("window.test.one", 120, 40);
    expect(() => rig.channel.fitWindowViewport("@1", 100, 30)).toThrow("unknown semantic window");
    expect(() => rig.channel.fitWindowViewport("window.other-session", 100, 30)).toThrow(
      "unknown semantic window",
    );
    expect(() => rig.channel.fitWindowViewport("window.test.one", 4097, 30)).toThrow(RangeError);
    expect(() => rig.channel.fitWindowViewport("window.test.one", 100, 2.5)).toThrow(RangeError);
    rig.channel.fitViewport(90, 28);
    expect(rig.sim.written.slice(before)).toEqual([
      "refresh-client -C @1:120x40",
      "refresh-client -C @1:",
      "refresh-client -C 90x28",
    ]);
    await rig.channel.dispose();
  });

  it("clears window overrides when participation ends and permits a new fit", async () => {
    const rig = await startedRig();
    rig.channel.setGeometryParticipation(true);
    const before = rig.sim.written.length;
    rig.channel.fitWindowViewport("window.test.one", 120, 40);
    rig.channel.setGeometryParticipation(false);
    rig.channel.setGeometryParticipation(false);
    rig.channel.fitWindowViewport("window.test.one", 120, 40);
    expect(rig.sim.written.slice(before)).toEqual([
      expect.stringContaining("if-shell -F -t '@1'"),
      "refresh-client -C @1:120x40",
      "refresh-client -C @1:",
      "refresh-client -f ignore-size",
      "refresh-client -C @1:120x40",
    ]);
    await rig.channel.dispose();
  });
});

describe("input path", () => {
  it("uses direct viewer captures without stock read markers or metadata-error replay", async () => {
    const adapter = {
      bindIo: vi.fn(),
      dispose: vi.fn(),
      tryDispatch: vi.fn<NonNullable<SessionChannelOptions["ownedViewer"]>["tryDispatch"]>(
        (_io, request, reply) => {
          reply({
            ok: true,
            lines: request.commands[0]!.includes("-R")
              ? ["invalid native backing"]
              : ["viewer snapshot"],
          });
          return true;
        },
      ),
    };
    const rig = await startedRig({ ownedViewer: adapter, nativeBirth: "11" });
    const handle = rig.channel.subscribePane("pane.alpha", () => {});
    completeSeed(rig, ["initial"], "0 0 100 50");
    const before = rig.sim.written.length;
    await handle.captureNativeBacking();
    expect(adapter.tryDispatch.mock.calls[0]![1].commands).toEqual([
      ["capture-pane", "-p", "-R", "-S", "-", "-t", "%1"],
    ]);
    expect(
      rig.sim.written
        .slice(before)
        .some(
          (command) =>
            command.includes("capture-pane") || command.includes(INTERNAL_READ_OPERATION_OPTION),
        ),
    ).toBe(false);
    await rig.channel.dispose();
  });
  it.each([true, false])(
    "preserves coalescing and single dispatch when native accepts=%s",
    async (accepted) => {
      const events: string[] = [];
      const adapter = {
        bindIo: vi.fn(),
        dispose: vi.fn(() => {
          events.push("disposed");
        }),
        tryDispatch: vi.fn<NonNullable<SessionChannelOptions["ownedViewer"]>["tryDispatch"]>(
          (_io, request, reply) => {
            if (request.commands[0]?.[0] !== "send-keys") return false;
            events.push(request.commands[0]!.join(" "));
            if (accepted) reply({ ok: false, lines: [] });
            return accepted;
          },
        ),
      };
      const rig = await startedRig({ ownedViewer: adapter, nativeBirth: "11" });
      expect(adapter.bindIo).toHaveBeenCalledExactlyOnceWith(rig.sim);
      const handle = rig.channel.subscribePane("pane.alpha", () => {});
      completeSeed(rig, ["s"], "0 0 100 50");
      const before = rig.sim.written.length;
      handle.sendText("hi");
      handle.sendText("!");
      handle.sendKey("Enter");
      expect(events).toEqual(["send-keys -t %1 -H 68 69 21", "send-keys -t %1 Enter"]);
      expect(rig.sim.written.slice(before)).toEqual(accepted ? [] : events);
      expect(adapter.tryDispatch.mock.calls[0]![1]).toMatchObject({
        paneId: "%1",
        paneBirthId: "11",
      });
      handle.sendText("x");
      await rig.channel.dispose();
      expect(events.slice(-2)).toEqual(["send-keys -t %1 -H 78", "disposed"]);
    },
  );

  it("keeps input on stock transport when physical birth is missing", async () => {
    const adapter = { bindIo: vi.fn(), tryDispatch: vi.fn(), dispose: vi.fn() };
    const rig = await startedRig({ ownedViewer: adapter });
    rig.channel.sendKey("pane.alpha", "Enter");
    expect(adapter.tryDispatch).not.toHaveBeenCalled();
    expect(rig.sim.written.at(-1)).toBe("send-keys -t %1 Enter");
    await rig.channel.dispose();
  });

  it("coalesces literals per pane and sends named keys after pending literals", async () => {
    const rig = await startedRig();
    const handle = rig.channel.subscribePane("pane.alpha", () => {});
    completeSeed(rig, ["s"], "0 0 100 50");
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
    completeSeed(rig, ["s"], "0 0 100 50");
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

describe("native capture semantic ownership", () => {
  const raw = () => [
    JSON.stringify({
      version: 1,
      cols: 100,
      rows: 50,
      history: 0,
      hscrolled: 0,
      limit: 2000,
      cursor: [0, 0],
    }),
    ...Array.from({ length: 50 }, (_, row) =>
      JSON.stringify({ row, flags: 0, used: 0, cells: [] }),
    ),
  ];
  it("clears successful backing metadata without retiring delayed observer proof", async () => {
    const rig = await startedRig();
    try {
      const capture = rig.channel.captureNativeBacking("pane.alpha");
      const command = rig.sim.written.findLast((line) => line.includes("capture-pane -p -R"))!;
      const marker = /@tmux_ide_read_operation ([^ ;]+)/u.exec(command)![1]!;
      const beforeReply = rig.sim.written.length;
      rig.sim.reply(raw());
      expect((await capture).status).toBe("captured");
      const cleanup = rig.sim.written
        .slice(beforeReply)
        .filter((line) => line.includes(INTERNAL_READ_OPERATION_OPTION));
      // A newer pane marker must not be deleted by this older read's cleanup.
      expect(cleanup).toEqual([
        `if-shell -t %1 -F "#{==:#{${INTERNAL_READ_OPERATION_OPTION}},${marker}}" ` +
          `"set-option -pu -t %1 ${INTERNAL_READ_OPERATION_OPTION}" ` +
          `"display-message -p -t %1 ''"`,
      ]);
      // The asynchronous observer may redeem after the server option is gone.
      expect(consumeInternalReadOperation(marker, "%1", "workspace.pane.read")).toBe(true);
      expect(consumeInternalReadOperation(marker, "%1", "workspace.pane.read")).toBe(false);
    } finally {
      await rig.channel.dispose();
    }
  });

  it("rejects raw backing crossed by pane output but permits sibling output and retry", async () => {
    const rig = await startedRig();
    try {
      const stale = rig.channel.captureNativeBacking("pane.alpha");
      rig.sim.output("%1", "changed");
      rig.sim.reply(raw());
      expect(await stale).toEqual({ status: "changed" });
      const fresh = rig.channel.captureNativeBacking("pane.alpha");
      rig.sim.output("%2", "sibling");
      rig.sim.reply(raw());
      const captured = await fresh;
      expect(captured.status).toBe("captured");
      if (captured.status !== "captured") throw new Error("Missing native backing");
      expect(captured.isCurrent()).toBe(true);
      rig.sim.output("%2", "more sibling output");
      expect(captured.isCurrent()).toBe(true);
      rig.sim.output("%1", "later pane output");
      expect(captured.isCurrent()).toBe(false);
    } finally {
      await rig.channel.dispose();
    }
  });

  it("rejects raw backing when layout changes and returns to its original geometry", async () => {
    const rig = await startedRig();
    const send = rig.sim.commandListBoundedInline.bind(rig.sim);
    let deliver: (() => void) | undefined;
    const hold = vi
      .spyOn(rig.sim, "commandListBoundedInline")
      .mockImplementation((command, count, index, limits, callback) => {
        send(command, count, index, limits, (reply) => {
          deliver = () => callback(reply);
        });
      });
    try {
      const stale = rig.channel.captureNativeBacking("pane.alpha");
      rig.sim.reply(raw());
      expect(deliver).toBeTypeOf("function");
      rig.sim.feedLines(
        `%layout-change @1 ${FIXTURE.layoutW1} aaaa,200x50,0,0{150x50,0,0,1,49x50,151,0,2} 0`,
        `%layout-change @1 ${FIXTURE.layoutW1} ${FIXTURE.layoutW1} 0`,
      );
      deliver!();
      expect(await stale).toEqual({ status: "changed" });
    } finally {
      hold.mockRestore();
      await rig.channel.dispose();
    }
  });

  it("rejects capture after its subscription closes while a peer remains live", async () => {
    const rig = await startedRig();
    const first = rig.channel.subscribePane("pane.alpha", () => {});
    completeSeed(rig, ["seed"], "0 0 100 50");
    const peerEvents = collect();
    const peer = rig.channel.subscribePane("pane.alpha", peerEvents.onEvent);
    completeSeed(rig, ["seed"], "0 0 100 50");
    try {
      const pending = first.captureNativeBacking();
      first.close();
      rig.sim.reply(raw());
      expect(await pending).toEqual({ status: "retired" });
      const written = rig.sim.written.length;
      expect(await first.captureNativeBacking()).toEqual({ status: "retired" });
      expect(rig.sim.written.length).toBe(written);
      rig.sim.feedLines("%output %1 peer-still-live");
      expect(bytesOf(peerEvents.events)).toContain("peer-still-live");
      const active = peer.captureNativeBacking();
      rig.sim.reply(raw());
      expect((await active).status).toBe("captured");
    } finally {
      peer.close();
      await rig.channel.dispose();
    }
  });
  it("rejects a delayed completion after the same runtime receives a new semantic binding", async () => {
    const rig = await startedRig();
    const send = rig.sim.commandListBoundedInline.bind(rig.sim);
    let deliver: (() => void) | undefined;
    const hold = vi
      .spyOn(rig.sim, "commandListBoundedInline")
      .mockImplementation((command, count, index, limits, callback) => {
        send(command, count, index, limits, (reply) => {
          deliver = () => callback(reply);
        });
      });
    try {
      const old = rig.channel.captureNativeBacking("pane.alpha");
      rig.sim.reply(raw());
      expect(deliver).toBeTypeOf("function");
      rig.state.descriptorRows[0] = rig.state.descriptorRows[0]!.replace(
        "%1\tpane.alpha\t",
        "%1\tpane.replacement\t",
      );
      rig.sim.feedLines("%layout-change @1 aaaa,200x50,0,0,2 aaaa,200x50,0,0,2 0");
      rig.pendingSyncs.shift()!();
      await vi.waitFor(() =>
        expect(
          rig.channel.describe().panes.some((p) => p.semanticPaneId === "pane.replacement"),
        ).toBe(true),
      );
      deliver!();
      expect(await old).toEqual({ status: "retired" });
      expect(await rig.channel.captureNativeBacking("pane.alpha")).toEqual({ status: "retired" });
      hold.mockRestore();
      const replacement = rig.channel.captureNativeBacking("pane.replacement");
      rig.sim.reply(raw());
      expect((await replacement).status).toBe("captured");
    } finally {
      hold.mockRestore();
      await rig.channel.dispose();
    }
  });
  it("settles an in-flight capture on disposal and ignores its later wire reply", async () => {
    const rig = await startedRig();
    const pending = rig.channel.captureNativeBacking("pane.alpha");
    await rig.channel.dispose();
    expect(await pending).toEqual({ status: "retired" });
    rig.sim.reply(raw());
    expect(await rig.channel.captureNativeBacking("pane.alpha")).toEqual({ status: "retired" });
  });
});

describe("native bootstrap capability fallback", () => {
  it("negotiates complete native grids including retained history before initial seed and reseed", async () => {
    const rig = await startedRig();
    const events = collect();
    const native = nativeBootstrapLines();
    native[0] = JSON.stringify({ ...JSON.parse(native[0]!), history: 1 });
    native.push(JSON.stringify({ row: 50, flags: 0, used: 0, cells: [] }));
    try {
      const handle = rig.channel.subscribePane("pane.alpha", events.onEvent, undefined, true);
      expect(rig.sim.written.at(-1)).toContain("capture-pane -p -R -S -");
      completeSeed(rig, native, "0 0 100 50");
      expect(events.events.find((event) => event.type === "seed")).toHaveProperty(
        "native.history",
        1,
      );
      events.events.length = 0;
      handle.reseed();
      completeSeed(rig, native, "0 0 100 50");
      expect(events.events.find((event) => event.type === "seed")).toHaveProperty(
        "native.history",
        1,
      );
      expect(events.events.some((event) => event.type === "fault")).toBe(false);
    } finally {
      await rig.channel.dispose();
    }
  });

  it.each(
    (["unsupported", "transient"] as const).flatMap((capability) =>
      (["reseed", "close", "freeze", "dispose"] as const).map((operation) => ({
        capability,
        operation,
      })),
    ),
  )(
    "retires a $capability replacement on $operation before admitting its queued sibling",
    async ({ capability, operation }) => {
      const rig = await startedRig();
      const alpha = collect();
      const beta = collect();
      try {
        const handle = rig.channel.subscribePane("pane.alpha", alpha.onEvent, undefined, true);
        rig.sim.reply(
          [
            capability === "unsupported"
              ? "command capture-pane: unknown flag -R"
              : "temporary failure",
          ],
          false,
        );
        if (capability === "transient") rig.sim.reply(nativeBootstrapLines());
        completeStockPause(rig, "%1");
        const collector = rig.armedAtomicCollectors.at(-1)!;
        rig.channel.subscribePane("pane.beta", beta.onEvent);
        if (operation === "dispose") await rig.channel.dispose();
        else handle[operation]();
        expect(bytesOf(alpha.events)).toEqual([]);
        expect(bytesOf(beta.events)).toEqual([]);
        expect(rig.armedAtomicCollectors.at(-1)).toBe(collector);
        // The actual raw owner remains until an ordinary transport fence drains.
        rig.sim.feedLines("%begin 1 888 0", "retired-capture", "%end 1 888 0");
        expect(bytesOf(alpha.events)).toEqual([]);
        if (operation !== "dispose") {
          drainRetiredAtomicCollector(rig, collector.nonce);
          completeSeed(rig, ["sibling"], "0 0 99 50");
          expect(bytesOf(beta.events)).toEqual(["sibling"]);
          if (operation === "reseed") {
            completeSeed(
              rig,
              capability === "unsupported" ? ["fresh alpha"] : nativeBootstrapLines(),
              "0 0 100 50",
            );
            expect(alpha.events.filter((event) => event.type === "seed")).toHaveLength(1);
          }
        }
        expect(alpha.events.some((event) => event.type === "fault")).toBe(false);
      } finally {
        await rig.channel.dispose();
      }
    },
  );

  it.each(["unsupported", "transient"] as const)(
    "keeps the newest same-pane request after cancelling a %s replacement",
    async (capability) => {
      const rig = await startedRig();
      const alpha = collect();
      try {
        const handle = rig.channel.subscribePane("pane.alpha", alpha.onEvent, undefined, true);
        rig.sim.reply(
          [
            capability === "unsupported"
              ? "command capture-pane: unknown flag -R"
              : "temporary failure",
          ],
          false,
        );
        if (capability === "transient") rig.sim.reply(nativeBootstrapLines());
        completeStockPause(rig, "%1");
        const collector = rig.armedAtomicCollectors.at(-1)!;
        handle.reseed();
        handle.reseed();
        for (const timer of rig.pendingRecoveries.filter((task) => task.cancelled))
          timer.callback();
        expect(bytesOf(alpha.events)).toEqual([]);
        drainRetiredAtomicCollector(rig, collector.nonce);
        completeStockPause(rig, "%1", false);
        completeAtomicRecoveryPhase(
          rig,
          capability === "unsupported" ? ["newest"] : nativeBootstrapLines(),
          "0 0 100 50",
          { continueNotify: true },
        );
        expect(alpha.events.filter((event) => event.type === "seed")).toHaveLength(1);
        expect(alpha.events.some((event) => event.type === "fault")).toBe(false);
        expect(rig.pendingRecoveries.filter((task) => !task.cancelled)).toEqual([]);
      } finally {
        await rig.channel.dispose();
      }
    },
  );

  it("reserves both cleanup replies before the next native capture and cursor", async () => {
    const rig = await startedRig();
    try {
      const commandList = vi.spyOn(rig.sim, "commandListInline");
      const marker = registerInternalReadOperation("%1");
      (
        rig.channel as unknown as {
          retireInternalReadMarker(runtime: string, marker: string): void;
        }
      ).retireInternalReadMarker("%1", marker);
      expect(commandList).toHaveBeenCalledWith(
        expect.stringContaining(`"display-message -p -t %1 ''"`),
        2,
        1,
        expect.any(Function),
      );
      const first = collect();
      rig.channel.subscribePane("pane.alpha", first.onEvent, undefined, true);
      completeSeed(rig, nativeBootstrapLines(), "0 0 100 50");
      expect(first.events.find((event) => event.type === "seed")).toHaveProperty(
        "native.version",
        2,
      );
      expect(rig.sim.core.pendingCount).toBe(0);
    } finally {
      await rig.channel.dispose();
    }
  });

  it("keeps a confirmed native server on native recovery after a failed capture", async () => {
    const rig = await startedRig();
    const first = collect();
    try {
      const handle = rig.channel.subscribePane("pane.alpha", first.onEvent, undefined, true);
      completeSeed(rig, nativeBootstrapLines(), "0 0 100 50");
      first.events.length = 0;
      handle.reseed();
      completeStockPause(rig, "%1");
      const collector = rig.armedAtomicCollectors.at(-1)!;
      completeAtomicRecoveryPhase(rig, [], "0 0 100 50", { errorOrdinal: 1 });
      expect(bytesOf(first.events)).toEqual([]);
      drainRetiredAtomicCollector(rig, collector.nonce);
      completeSeed(rig, nativeBootstrapLines(), "0 0 100 50");
      expect(first.events.find((event) => event.type === "seed")).toHaveProperty(
        "native.version",
        2,
      );
      expect(rig.sim.written.some((command) => command.includes("capture-pane -p -e -J"))).toBe(
        false,
      );
    } finally {
      await rig.channel.dispose();
    }
  });

  it("retries unknown native capability within the original deadline and cancels a late probe", async () => {
    const rig = await startedRig();
    const first = collect();
    try {
      const handle = rig.channel.subscribePane("pane.alpha", first.onEvent, undefined, true);
      advanceRecoveryClock(rig, 400);
      rig.sim.reply(["temporary failure"], false);
      expect(
        rig.sim.written.filter((command) => command.includes("capture-pane -p -R")),
      ).toHaveLength(2);
      const deadlines = rig.pendingRecoveries.filter((task) => !task.cancelled);
      expect(deadlines.some((task) => task.dueAtMs === 5000)).toBe(true);
      expect(deadlines.some((task) => task.dueAtMs > 5000)).toBe(false);
      handle.close();
      rig.sim.reply(nativeBootstrapLines());
      advanceRecoveryClock(rig, 10000);
      expect(first.events.some((event) => event.type === "seed")).toBe(false);
    } finally {
      await rig.channel.dispose();
    }
  });

  it("recovers stock capability after a transient initial probe failure", async () => {
    const rig = await startedRig();
    const first = collect();
    try {
      rig.channel.subscribePane("pane.alpha", first.onEvent, undefined, true);
      rig.sim.reply(["temporary failure"], false);
      rig.sim.reply(["parse error: command capture-pane: unknown flag -R"], false);
      completeSeed(rig, ["portable recovered"], "0 0 100 50");
      expect(bytesOf(first.events)).toEqual(["portable recovered"]);
      expect(
        rig.sim.written.filter((command) => command.includes("capture-pane -p -R")),
      ).toHaveLength(2);
    } finally {
      await rig.channel.dispose();
    }
  });

  it("bounds persistent malformed native probes without publishing portable content", async () => {
    const rig = await startedRig();
    const first = collect();
    try {
      rig.channel.subscribePane("pane.alpha", first.onEvent, undefined, true);
      rig.sim.reply(["malformed native capture"]);
      rig.sim.reply(["second malformed capability probe"]);
      advanceRecoveryClock(rig, 10000);
      expect(first.events.filter((event) => event.type === "fault")).toHaveLength(1);
      expect(first.events.some((event) => event.type === "seed")).toBe(false);
      expect(rig.sim.written.some((command) => command.includes("capture-pane -p -e -J"))).toBe(
        false,
      );
    } finally {
      await rig.channel.dispose();
    }
  });

  it("recovers a malformed shared native capture at a new authenticated seam", async () => {
    const rig = await startedRig();
    const first = collect();
    try {
      rig.channel.subscribePane("pane.alpha", first.onEvent, undefined, true);
      completeSeed(rig, nativeBootstrapLines(), "0 0 100 50");
      first.events.length = 0;
      rig.sim.feedLines("%pause %1");
      completeSeed(rig, ["malformed"], "0 0 100 50");
      expect(bytesOf(first.events)).toEqual([]);
      completeSeed(rig, nativeBootstrapLines(), "0 0 100 50");
      expect(first.events.find((event) => event.type === "seed")).toHaveProperty(
        "native.version",
        2,
      );
      expect(rig.sim.written.some((command) => command.includes("capture-pane -p -e -J"))).toBe(
        false,
      );
    } finally {
      await rig.channel.dispose();
    }
  });

  it("fails closed when a transport cannot own the stock collector", async () => {
    const rig = await startedRig({ atomicHook: false });
    const first = collect();
    try {
      rig.channel.subscribePane("pane.alpha", first.onEvent, undefined, true);
      advanceRecoveryClock(rig, 5001);
      expect(first.events.some((event) => event.type === "seed")).toBe(false);
      expect(first.events.filter((event) => event.type === "fault")).toHaveLength(1);
      expect(rig.sim.written.some((command) => command.includes("capture-pane"))).toBe(false);
    } finally {
      await rig.channel.dispose();
    }
  });

  it.each(["failed", "malformed"])(
    "recovers native capability after a transient %s capture",
    async (kind) => {
      const rig = await startedRig();
      const native = nativeBootstrapLines();
      try {
        const first = collect();
        rig.channel.subscribePane("pane.alpha", first.onEvent, undefined, true);
        rig.sim.reply(
          [kind === "failed" ? "temporary capture failure" : "truncated native JSON"],
          kind !== "failed",
        );
        completeSeed(rig, native, "0 0 100 50");
        expect(first.events.find((event) => event.type === "seed")).toHaveProperty(
          "native.version",
          2,
        );
        expect(rig.sim.written.some((command) => command.includes("capture-pane -p -e -J"))).toBe(
          false,
        );
        const before = rig.sim.written.filter((command) =>
          command.includes("capture-pane -p -R"),
        ).length;
        const peer = collect();
        rig.channel.subscribePane("pane.alpha", peer.onEvent, undefined, true);
        expect(
          rig.sim.written.filter((command) => command.includes("capture-pane -p -R")),
        ).toHaveLength(before);
        completeSeed(rig, native, "0 0 100 50");
        expect(peer.events.find((event) => event.type === "seed")).toHaveProperty(
          "native.version",
          2,
        );
      } finally {
        await rig.channel.dispose();
      }
    },
  );

  it.each(["stock", "v1", "backing-only-v2"])(
    "restarts at a fresh capture seam and caches explicit %s capability",
    async (capability) => {
      const rig = await startedRig();
      try {
        const first = collect();
        rig.channel.subscribePane("pane.alpha", first.onEvent, undefined, true);
        expect(rig.sim.written.some((command) => command.includes("capture-pane -p -R"))).toBe(
          true,
        );
        if (capability === "stock") rig.sim.reply(["command capture-pane: unknown flag -R"], false);
        else {
          const lines = nativeBootstrapLines();
          const header = JSON.parse(lines[0]!);
          delete header.currentAttributes;
          if (capability === "v1") header.version = 1;
          lines[0] = JSON.stringify(header);
          rig.sim.reply(lines);
        }
        rig.sim.feedLines("%output %1 discarded-before-fallback");
        completeStockPause(rig, "%1");
        rig.sim.feedLines("%output %1 held-after-fallback");
        completeAtomicRecoveryPhase(rig, ["portable"], "0 0 100 50", { continueNotify: true });
        expect(bytesOf(first.events)).toEqual(["portable", "held-after-fallback"]);
        expect(first.events.filter((event) => event.type === "seed")).toHaveLength(1);
        const count = rig.sim.written.filter((command) =>
          command.includes("capture-pane -p -R"),
        ).length;
        const peer = collect();
        rig.channel.subscribePane("pane.alpha", peer.onEvent, undefined, true);
        expect(
          rig.sim.written.filter((command) => command.includes("capture-pane -p -R")),
        ).toHaveLength(count);
        completeSeed(rig, ["peer"], "0 0 100 50");
        expect(bytesOf(peer.events)).toEqual(["peer"]);
      } finally {
        await rig.channel.dispose();
      }
    },
  );
});

describe("native recovery formats", () => {
  it.each([false, true])(
    "publishes complete native seeds alongside optional ANSI viewers (mixed=%s)",
    async (mixed) => {
      const rig = await startedRig();
      const canonical = collect();
      const legacy = collect();
      try {
        rig.channel.subscribePane("pane.alpha", canonical.onEvent, undefined, true);
        completeSeed(rig, nativeBootstrapLines(), "0 0 100 50");
        if (mixed) {
          rig.channel.subscribePane("pane.alpha", legacy.onEvent);
          completeStockPause(rig, "%1");
          completeAtomicRecoveryPhase(rig, nativeBootstrapLines(), "0 0 100 50", {
            continueNotify: true,
            ansiCaptureLines: ["legacy initial"],
          });
        }
        canonical.events.length = legacy.events.length = 0;
        rig.sim.feedLines("%pause %1");
        completeStockPause(rig, "%1", false);
        rig.sim.output("%1", "SHARED-TAIL");
        completeAtomicRecoveryPhase(rig, nativeBootstrapLines(), "0 0 100 50", {
          continueNotify: true,
          ansiCaptureLines: ["legacy recovered"],
        });
        const seed = canonical.events.find((event) => event.type === "seed");
        expect(seed).toHaveProperty("native.version", 2);
        expect(seed).not.toHaveProperty("requiresNativeRecapture");
        expect(bytesOf(canonical.events)).toEqual(["", "SHARED-TAIL"]);
        if (mixed) {
          expect(bytesOf(legacy.events)).toEqual(["legacy recovered", "SHARED-TAIL"]);
          expect(legacy.events.find((event) => event.type === "seed")).not.toHaveProperty("native");
        }
      } finally {
        await rig.channel.dispose();
      }
    },
  );
});

function nativeBootstrapLines(): string[] {
  return [
    JSON.stringify({
      version: 2,
      currentAttributes: [0, 8, 8, 8],
      cols: 100,
      rows: 50,
      history: 0,
      hscrolled: 0,
      limit: 2000,
      cursor: [0, 0],
    }),
    ...Array.from({ length: 50 }, (_, row) =>
      JSON.stringify({ row, flags: 0, used: 0, cells: [] }),
    ),
  ];
}

describe("native window link projection", () => {
  it("shares backing layouts and panes across duplicate links and observes same-backing activation", async () => {
    const rig = await startedRig();
    try {
      rig.state.descriptorRows[2] = rig.state.descriptorRows[2]!.replace(
        "%3\t\t",
        "%3\tpane.mirror.gen1\t",
      ).replace("\t\tzz-sim\t1\t2", "\twindow.test.two\tzz-sim\t1\t2");
      const first = rig.state.windowRows[0]!.split("\t");
      first[3] = "0";
      rig.state.windowRows.push(first.join("\t"));
      rig.state.descriptorRows = rig.state.descriptorRows.map((row) =>
        row.replace(/\t2\t$/, "\t3\t"),
      );
      rig.state.descriptorRows.push(
        ...rig.state.descriptorRows.slice(0, 2).map((row) => {
          const p = row.split("\t");
          p[15] = "0";
          p[6] = "2";
          return p.join("\t");
        }),
      );
      const snapshots: MirrorLayoutAuthoritySnapshot[] = [];
      const handle = await rig.channel.subscribeAuthoritativeLayout(
        () => {},
        undefined,
        (snapshot) => snapshots.push(snapshot),
      );
      const initial = snapshots.at(-1)!;
      expect(initial.layouts).toHaveLength(2);
      expect(initial.windowLinks.links).toHaveLength(3);
      expect(rig.channel.describe().panes).toHaveLength(3);
      const stamps = rig.sim.written.filter((command) =>
        command.startsWith("set-option -w"),
      ).length;
      const linked = initial.windowLinks.links.filter(
        (link) => link.semanticWindowId === "window.test.one",
      );
      expect(linked).toHaveLength(2);
      await expect(
        rig.channel.executeWindowLinkAction({ action: "select", paneId: "pane.alpha" }),
      ).rejects.toMatchObject({ reason: "window_link_ambiguous" });
      rig.state.windowRows = rig.state.windowRows.map((row, index) => {
        const p = row.split("\t");
        p[3] = index === 2 ? "1" : "0";
        return p.join("\t");
      });
      rig.sim.feedLines("%session-window-changed $1 @1");
      rig.pendingSyncs.shift()!();
      await vi.waitFor(() =>
        expect(snapshots.at(-1)!.windowLinks.activeLinkId).toBe(linked[1]!.linkId),
      );
      expect(snapshots.at(-1)!.windowLinks.linkRevision).toBe(initial.windowLinks.linkRevision);
      expect(snapshots.at(-1)!.layouts).toHaveLength(2);
      expect(rig.sim.written.filter((command) => command.startsWith("set-option -w"))).toHaveLength(
        stamps,
      );
      handle.close();
    } finally {
      await rig.channel.dispose();
    }
  });
});

it("bounds stalled post-mutation reconciliation and never revives revoked link handles", async () => {
  const execute = vi.fn(async () => ({ status: 0, stdout: "link-guard.ok" }));
  const rig = await startedRig({ executeWindowLinkGuard: execute });
  try {
    rig.state.descriptorRows[2] = rig.state.descriptorRows[2]!.replace(
      "%3\t\t",
      "%3\tpane.mirror.gen1\t",
    ).replace("\t\tzz-sim\t1\t2", "\twindow.test.two\tzz-sim\t1\t2");
    const snapshots: MirrorLayoutAuthoritySnapshot[] = [];
    await rig.channel.subscribeAuthoritativeLayout(
      () => {},
      undefined,
      (snapshot) => snapshots.push(snapshot),
    );
    const initial = snapshots.at(-1)!.windowLinks;
    const link = initial.links[0]!;
    const target = {
      liveSessionId: initial.liveSessionId,
      linkRevision: initial.linkRevision,
      linkId: link.linkId,
      expectedSemanticWindowId: link.semanticWindowId,
    };
    let release!: (lines: string[]) => void;
    vi.spyOn(rig.sim, "request").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    vi.useFakeTimers();
    const result = rig.channel.executeWindowLinkAction({ action: "select", target });
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toEqual({ outcome: "applied", windowLinks: null });
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(
      rig.channel.executeWindowLinkAction({ action: "select", target }),
    ).rejects.toMatchObject({ reason: "window_link_stale" });
    release(rig.state.truthRows);
    await vi.advanceTimersByTimeAsync(1);
    expect(snapshots.at(-1)!.windowLinks.links[0]!.linkId).not.toBe(link.linkId);
    await expect(
      rig.channel.executeWindowLinkAction({ action: "select", target }),
    ).rejects.toMatchObject({ reason: "window_link_stale" });
    expect(execute).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
    await rig.channel.dispose();
  }
});

describe("native capture-resume recovery", () => {
  const epoch = "00000000-0000-4000-8000-000000000001";
  function snapshot() {
    return {
      ok: true,
      lines: [
        JSON.stringify({
          snapshotVersion: 1,
          serverEpoch: epoch,
          paneId: "%1",
          paneBirthId: "11",
          resumed: true,
          cursor: "1 0 100 50 0 1 0 0 0 0 0 0 0 1 0 2000 0 0 0 0 0 0 1",
        }),
        JSON.stringify({
          version: 2,
          cols: 100,
          rows: 50,
          history: 0,
          hscrolled: 0,
          limit: 2000,
          cursor: [1, 0],
          currentAttributes: [0, 8, 8, 8],
        }),
        JSON.stringify({ row: 0, flags: 0, used: 1, cells: [[0, 1, "41", 0, 8, 8, 8, 0, 0]] }),
        ...Array.from({ length: 49 }, (_, index) =>
          JSON.stringify({ row: index + 1, flags: 0, used: 0, cells: [] }),
        ),
        "%continue %1",
      ],
    };
  }
  async function setup(plain = false, manualPause = false, dual = false) {
    let nativeCapabilityReady = false;
    const callbacks: Array<(reply: { ok: boolean; lines: string[] }) => void> = [];
    const adapter = {
      bindIo: vi.fn(),
      dispose: vi.fn(),
      atomicSnapshotEpoch: vi.fn((_io, representation = "native") =>
        !nativeCapabilityReady || (representation === "dual" && !dual)
          ? null
          : (epoch as string | null),
      ),
      tryDispatch: vi.fn<NonNullable<SessionChannelOptions["ownedViewer"]>["tryDispatch"]>(
        (_io, request, reply) => {
          if (!request.commands[0]?.includes("-Q")) return false;
          callbacks.push(reply);
          return true;
        },
      ),
    };
    const rig = await startedRig({
      ownedViewer: adapter,
      nativeBirth: "11",
      continueReply: manualPause ? "manual" : "auto-success",
    });
    const events = collect();
    const handle = rig.channel.subscribePane("pane.alpha", events.onEvent, undefined, !plain);
    completeSeed(rig, plain ? ["plain"] : nativeBootstrapLines(), "0 0 100 50");
    nativeCapabilityReady = true;
    events.events.length = 0;
    return { rig, adapter, callbacks, events, handle };
  }
  it.each([false, true])(
    "delivers negotiated dual snapshots to plain/mixed subscribers: %s",
    async (mixed) => {
      const s = await setup(true, false, true);
      const nativeEvents = collect();
      try {
        if (mixed) {
          s.rig.channel.subscribePane("pane.alpha", nativeEvents.onEvent, undefined, true);
          const initial = snapshot();
          initial.lines[0] = JSON.stringify({
            ...JSON.parse(initial.lines[0]!),
            snapshotVersion: 2,
            representation: "dual",
          });
          initial.lines.splice(
            -1,
            0,
            JSON.stringify({ ansiHex: "410a" }),
            JSON.stringify({ ansiEnd: true, bytes: 2, chunks: 1 }),
          );
          s.callbacks.shift()!(initial);
          nativeEvents.events.length = 0;
          s.events.events.length = 0;
        }
        s.rig.sim.feedLines("%pause %1");
        expect(s.adapter.tryDispatch.mock.calls.at(-1)?.[1].commands[0]).toContain("-D");
        const rows = snapshot().lines.slice(0, -1);
        rows[0] = JSON.stringify({
          ...JSON.parse(rows[0]!),
          snapshotVersion: 2,
          representation: "dual",
        });
        s.callbacks[0]!({
          ok: true,
          lines: [
            ...rows,
            JSON.stringify({ ansiHex: "410a" }),
            JSON.stringify({ ansiEnd: true, bytes: 2, chunks: 1 }),
            "%continue %1",
          ],
        });
        const plainSeed = s.events.events.find((e) => e.type === "seed");
        expect(plainSeed).not.toHaveProperty("native");
        expect(bytesOf(s.events.events)).toEqual(["A"]);
        if (mixed) {
          expect(nativeEvents.events.find((e) => e.type === "seed")).toHaveProperty(
            "native.version",
            2,
          );
          expect(bytesOf(nativeEvents.events)).toEqual([""]);
        }
      } finally {
        await s.rig.channel.dispose();
      }
    },
  );
  it("publishes one atomic grid synchronously and admits following output without continue debt", async () => {
    const s = await setup();
    try {
      s.rig.sim.feedLines("%pause %1");
      expect(s.callbacks).toHaveLength(1);
      expect(s.rig.sim.written.at(-1)).toBe("refresh-client -A '%1:pause'");
      s.callbacks[0]!(snapshot());
      s.rig.sim.feedLines("%output %1 after");
      expect(s.events.events.filter((e) => e.type === "seed")).toHaveLength(1);
      expect(bytesOf(s.events.events)).toEqual(["", "after"]);
      expect(s.events.events).toContainEqual({
        type: "flow",
        state: "resumed",
        reason: "backpressure",
      });
      s.rig.sim.feedLines("%continue %1", "%output %1 still-live");
      expect(bytesOf(s.events.events)).toEqual(["", "after", "still-live"]);
      expect(s.rig.pendingRecoveries.filter((t) => !t.cancelled)).toEqual([]);
    } finally {
      await s.rig.channel.dispose();
    }
  });
  it.each([false, true])(
    "repauses after unknown committed output without stock replay (dual=%s)",
    async (dual) => {
      const s = await setup(dual, false, dual);
      const valid = () => {
        const reply = snapshot();
        if (dual) {
          reply.lines[0] = JSON.stringify({
            ...JSON.parse(reply.lines[0]!),
            snapshotVersion: 2,
            representation: "dual",
          });
          reply.lines.splice(
            -1,
            0,
            JSON.stringify({ ansiHex: "410a" }),
            JSON.stringify({ ansiEnd: true, bytes: 2, chunks: 1 }),
          );
        }
        return reply;
      };
      try {
        s.rig.sim.feedLines("%pause %1");
        s.callbacks[0]!({ ok: true, lines: ["malformed", "%continue %1"] });
        s.rig.sim.feedLines("%output %1 discarded");
        expect(s.events.events.some((e) => e.type === "seed")).toBe(false);
        expect(s.callbacks).toHaveLength(2);
        expect(s.rig.sim.written.filter((c) => c === "refresh-client -A '%1:pause'")).toHaveLength(
          2,
        );
        s.callbacks[0]!(valid()); // late callback cannot publish another attempt
        expect(s.events.events.some((e) => e.type === "seed")).toBe(false);
        s.callbacks[1]!(valid());
        expect(s.events.events.filter((e) => e.type === "seed")).toHaveLength(1);
      } finally {
        await s.rig.channel.dispose();
      }
    },
  );
  it.each(["epoch", "dispose", "membership"])("does not publish stale %s replies", async (kind) => {
    const s = await setup();
    try {
      s.rig.sim.feedLines("%pause %1");
      if (kind === "epoch")
        s.adapter.atomicSnapshotEpoch.mockReturnValue("00000000-0000-4000-8000-000000000002");
      if (kind === "dispose") await s.rig.channel.dispose();
      if (kind === "membership") s.handle.close();
      s.callbacks[0]!(snapshot());
      expect(s.events.events.some((e) => e.type === "seed")).toBe(false);
    } finally {
      await s.rig.channel.dispose();
    }
  });
  it("keeps plain subscribers on their existing ANSI path", async () => {
    const s = await setup(true);
    try {
      s.rig.sim.feedLines("%pause %1");
      expect(s.callbacks).toHaveLength(0);
    } finally {
      await s.rig.channel.dispose();
    }
  });
  it("publishes native and ANSI seeds together for mixed stock participants", async () => {
    const s = await setup();
    const plain = collect();
    try {
      s.rig.channel.subscribePane("pane.alpha", plain.onEvent);
      completeStockPause(s.rig, "%1");
      completeAtomicRecoveryPhase(s.rig, nativeBootstrapLines(), "0 0 100 50", {
        ansiCaptureLines: ["plain"],
        continueNotify: true,
      });
      expect(s.events.events.find((event) => event.type === "seed")).toHaveProperty(
        "native.version",
        2,
      );
      expect(bytesOf(plain.events)).toEqual(["plain"]);
      s.rig.sim.feedLines("%pause %1");
      expect(s.callbacks).toHaveLength(0);
    } finally {
      await s.rig.channel.dispose();
    }
  });
  it("does not send another pause or capture after owner epoch changes", async () => {
    const s = await setup();
    try {
      s.rig.sim.feedLines("%pause %1");
      s.adapter.atomicSnapshotEpoch.mockReturnValue("00000000-0000-4000-8000-000000000002");
      s.callbacks[0]!(snapshot());
      advanceRecoveryClock(s.rig, 40);
      expect(s.callbacks).toHaveLength(1);
      expect(s.rig.sim.written.filter((c) => c === "refresh-client -A '%1:pause'")).toHaveLength(1);
      expect(s.events.events).toContainEqual({ type: "fault", reason: "native-recovery-failed" });
    } finally {
      await s.rig.channel.dispose();
    }
  });
  it("ignores a timed-out child's late reply before retrying behind another pause", async () => {
    const s = await setup();
    try {
      s.rig.sim.feedLines("%pause %1");
      advanceRecoveryClock(s.rig, 500);
      s.callbacks[0]!(snapshot());
      expect(s.events.events.some((e) => e.type === "seed")).toBe(false);
      advanceRecoveryClock(s.rig, 40);
      s.callbacks[1]!(snapshot());
      expect(s.events.events.filter((e) => e.type === "seed")).toHaveLength(1);
    } finally {
      await s.rig.channel.dispose();
    }
  });
  it("fences repeated pause notifications before and after pause acknowledgement", async () => {
    const s = await setup(false, true);
    try {
      s.rig.sim.feedLines("%pause %1", "%pause %1", "%pause %1");
      expect(s.callbacks).toHaveLength(0);
      s.rig.sim.reply([]);
      expect(s.callbacks).toHaveLength(1);
      // A later actual backpressure pause invalidates the capture instead of
      // letting its inline continue discharge the new recovery's ownership.
      s.rig.sim.feedLines("%pause %1", "%pause %1");
      s.callbacks[0]!(snapshot());
      expect(s.events.events.some((e) => e.type === "seed")).toBe(false);
      s.rig.sim.reply([]);
      expect(s.callbacks).toHaveLength(2);
      s.callbacks[1]!(snapshot());
      expect(s.events.events.filter((e) => e.type === "seed")).toHaveLength(1);
    } finally {
      await s.rig.channel.dispose();
    }
  });
  it("retires a synchronous delivery when its subscriber freezes and thaws", async () => {
    const s = await setup();
    const append = s.events.events.push.bind(s.events.events);
    let changed = false;
    const spy = vi.spyOn(s.events.events, "push").mockImplementation((...events) => {
      const result = append(...events);
      if (!changed && events.some((event) => event.type === "reset")) {
        changed = true;
        s.handle.freeze();
        s.handle.thaw();
      }
      return result;
    });
    try {
      s.rig.sim.feedLines("%pause %1");
      s.callbacks[0]!(snapshot());
      expect(s.events.events.some((e) => e.type === "seed")).toBe(false);
      expect(s.callbacks).toHaveLength(2);
      spy.mockRestore();
      s.callbacks[1]!(snapshot());
      expect(s.events.events.filter((e) => e.type === "seed")).toHaveLength(1);
    } finally {
      spy.mockRestore();
      await s.rig.channel.dispose();
    }
  });
  it("rejects a native snapshot spanning resize-back even when final geometry matches", async () => {
    const s = await setup();
    try {
      s.rig.sim.feedLines("%pause %1");
      s.rig.sim.feedLines(
        `%layout-change @1 ${FIXTURE.layoutW1} aaaa,200x50,0,0{150x50,0,0,1,49x50,151,0,2} 0`,
        `%layout-change @1 ${FIXTURE.layoutW1} ${FIXTURE.layoutW1} 0`,
      );
      s.callbacks[0]!(snapshot());
      expect(bytesOf(s.events.events)).toEqual([]);
      expect(s.rig.pendingSyncs).toHaveLength(1);
      s.rig.pendingSyncs.shift()!();
      await vi.waitFor(() => expect(s.callbacks).toHaveLength(2));
      s.callbacks[1]!(snapshot());
      expect(s.events.events.filter((event) => event.type === "seed")).toHaveLength(1);
    } finally {
      await s.rig.channel.dispose();
    }
  });
  it("cancels a converged native lease fence timer on disposal without admitting its sibling", async () => {
    const s = await setup();
    const beta = collect();
    const inline = s.rig.sim.commandInline.bind(s.rig.sim);
    let fence: string | null = null;
    s.rig.sim.commandInline = (command, onReply) => {
      if (command.startsWith("display-message -p -l tmux-ide-snapshot-admission:")) {
        fence = command.slice("display-message -p -l ".length);
        s.rig.sim.core.push({ kind: "inline", onReply, lines: [] });
        s.rig.sim.written.push(command);
      } else inline(command, onReply);
    };
    try {
      s.rig.sim.feedLines("%pause %1");
      s.rig.channel.subscribePane("pane.beta", beta.onEvent);
      const collectors = s.rig.armedAtomicCollectors.length;
      s.callbacks[0]!(snapshot());
      expect(s.events.events.filter((event) => event.type === "seed")).toHaveLength(1);
      expect(fence).not.toBeNull();
      expect(s.rig.armedAtomicCollectors).toHaveLength(collectors);
      await s.rig.channel.dispose();
      expect(s.rig.pendingRecoveries.filter((task) => !task.cancelled)).toEqual([]);
      s.rig.sim.reply([fence!]);
      advanceRecoveryClock(s.rig, 10_000);
      expect(s.rig.armedAtomicCollectors).toHaveLength(collectors);
      expect(bytesOf(beta.events)).toEqual([]);
    } finally {
      await s.rig.channel.dispose();
    }
  });
  it("releases shared admission when a native subscriber throws during resumed delivery", async () => {
    const s = await setup();
    const beta = collect();
    const append = s.events.events.push.bind(s.events.events);
    const spy = vi.spyOn(s.events.events, "push").mockImplementation((...events) => {
      if (events.some((event) => event.type === "flow" && event.state === "resumed")) {
        throw new Error("consumer callback failed");
      }
      return append(...events);
    });
    try {
      s.rig.sim.feedLines("%pause %1");
      s.rig.channel.subscribePane("pane.beta", beta.onEvent);
      expect(() => s.callbacks[0]!(snapshot())).not.toThrow();
      expect(s.rig.armedAtomicCollectors.at(-1)).toMatchObject({
        kind: "pause",
        runtimePaneId: "%2",
      });
      completeSeed(s.rig, ["BETA"], "4 0 99 50");
      expect(bytesOf(beta.events)).toEqual(["BETA"]);
    } finally {
      spy.mockRestore();
      await s.rig.channel.dispose();
    }
  });
  it("degrades throwing optional capability lookup to ordinary recovery before dispatch", async () => {
    const s = await setup();
    try {
      s.adapter.atomicSnapshotEpoch.mockImplementation(() => {
        throw new Error("retired capability");
      });
      expect(() => s.rig.sim.feedLines("%pause %1")).not.toThrow();
      expect(s.callbacks).toHaveLength(0);
      completeStockPause(s.rig, "%1", false);
      completeAtomicRecoveryPhase(s.rig, nativeBootstrapLines(), "0 0 100 50", {
        continueNotify: true,
      });
      expect(s.events.events.filter((event) => event.type === "seed")).toHaveLength(1);
      expect(s.events.events.find((event) => event.type === "seed")).toHaveProperty("native");
    } finally {
      await s.rig.channel.dispose();
    }
  });
  it("bounds missing replies with existing attempt and absolute deadlines", async () => {
    const s = await setup();
    try {
      s.rig.sim.feedLines("%pause %1");
      advanceRecoveryClock(s.rig, 5000);
      expect(s.callbacks).toHaveLength(4);
      expect(s.events.events).toContainEqual({ type: "fault", reason: "native-recovery-failed" });
      for (const reply of s.callbacks) reply(snapshot());
      expect(s.events.events.some((e) => e.type === "seed")).toBe(false);
    } finally {
      await s.rig.channel.dispose();
    }
  });
});
