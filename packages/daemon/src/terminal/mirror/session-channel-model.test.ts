import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionChannel } from "./session-channel.ts";
import type { MirrorPaneEvent } from "./events.ts";
import { FIXTURE } from "./__tests__/simulated-channel.ts";
import {
  SessionModelChannel,
  ModelHarnessError,
  type ModelCut,
} from "./__tests__/session-model-channel.ts";

type Round = {
  id: number;
  pane: "%1" | "%2";
  before: string;
  after: string;
  partition: number;
  operation:
    | "reseed"
    | "gap"
    | "join"
    | "cancel"
    | "freeze"
    | "disconnect"
    | "overflow"
    | "capture-error"
    | "late-wire";
};
type Mutation = "lost-output" | "duplicate-output" | "stale-publication" | "metadata-order";
class ModelInvariant extends Error {
  constructor(
    readonly code: string,
    readonly victim: string,
    message: string,
  ) {
    super(`${code}:${victim}: ${message}`);
  }
}
const invariant = (condition: unknown, code: string, victim: string, message: string): void => {
  if (!condition) throw new ModelInvariant(code, victim, message);
};
type View = {
  id: string;
  pane: string;
  handle: ReturnType<SessionChannel["subscribePane"]>;
  closed: boolean;
  frozen: boolean;
  text: string;
  phase: "live" | "reset" | "seed";
  generation: number;
};

/** Independent append-only transcript model. It consumes public events, not
 * PaneFeed/StockPaneSnapshot states or reducers. Captures carry separate cuts. */
async function replay(rounds: readonly Round[], mutation?: Mutation) {
  const views = new Map<string, View>();
  const generations = new Map([
    ["%1", 0],
    ["%2", 0],
  ]);
  const worlds = new Map([
    ["%1", ""],
    ["%2", ""],
  ]);
  const cuts = new Map<string, ModelCut>();
  const trace: Record<string, unknown>[] = [];
  const observations: Array<{ viewer: string; type: string; text?: string }> = [];
  const timers: Array<{ due: number; cancelled: boolean; callback: () => void }> = [];
  let now = 0;
  let transport!: SessionModelChannel;
  let mutationUsed = false;
  let mutationArmed = false;
  let observationFailure: ModelInvariant | null = null;
  const active = (pane: string) =>
    [...views.values()].filter((view) => view.pane === pane && !view.closed && !view.frozen);
  const bump = (pane: string) => generations.set(pane, generations.get(pane)! + 1);
  const channel = new SessionChannel({
    session: FIXTURE.session,
    createIo: (handlers) =>
      (transport = new SessionModelChannel(handlers, {
        trace: (event) => trace.push(event),
        schedule: (callback, delay) => {
          const timer = { callback, due: now + delay, cancelled: false };
          timers.push(timer);
          return () => {
            timer.cancelled = true;
          };
        },
        context: (pane) => ({
          participants: active(pane).map((view) => view.id),
          generation: generations.get(pane)!,
        }),
        cut: (cut) => {
          invariant(
            cut.text === worlds.get(cut.pane),
            "capture-cut",
            cut.pane,
            "server capture differs from independent producer world",
          );
          cuts.set(cut.pane, cut);
        },
      })),
    generatePaneId: () => "pane.mirror.gen1",
    generateWindowId: () => "window.mirror.gen1",
    generateAtomicHookNonce: (() => {
      let nonce = 0;
      return () => (++nonce).toString(16).padStart(32, "0");
    })(),
    scheduleSync: () => () => {},
    scheduleRecovery: (callback, delay) => {
      const timer = { callback, due: now + delay, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    recoveryNowMs: () => now,
  });
  const observe = (view: View, event: MirrorPaneEvent) => {
    const text =
      event.type === "seed" || event.type === "delta"
        ? Buffer.from(event.data).toString()
        : undefined;
    trace.push({ type: "public", viewer: view.id, event: event.type, text });
    observations.push({
      viewer: view.id,
      type: event.type,
      ...(text === undefined ? {} : { text }),
    });
    if (
      event.type === "reset" ||
      event.type === "seed" ||
      event.type === "cursor" ||
      event.type === "delta"
    ) {
      invariant(
        !view.closed && !view.frozen,
        "stale-publication",
        view.id,
        "bytes or metadata after subscriber retirement",
      );
    }
    if (event.type === "reset") {
      const cut = cuts.get(view.pane);
      invariant(
        cut && cut.generation === generations.get(view.pane) && cut.participants.includes(view.id),
        "stale-publication",
        view.id,
        "snapshot belongs to an obsolete generation",
      );
      view.text = "";
      view.phase = "reset";
      view.generation = cut!.generation;
    } else if (event.type === "seed") {
      invariant(view.phase === "reset", "metadata-order", view.id, "seed without reset");
      invariant(
        text === cuts.get(view.pane)?.text,
        "capture-cut",
        view.id,
        "seed differs from capture cut",
      );
      view.text = text!;
      view.phase = "seed";
    } else if (event.type === "cursor") {
      invariant(view.phase === "seed", "metadata-order", view.id, "cursor without seed");
      view.phase = "live";
    } else if (event.type === "delta") {
      invariant(
        view.generation === generations.get(view.pane),
        "stale-publication",
        view.id,
        "delta crossed requested generation",
      );
      invariant(
        active(view.pane).every(
          (participant) =>
            participant.phase === "live" && participant.generation === view.generation,
        ),
        "metadata-order",
        view.id,
        "tail preceded a participant's baseline metadata",
      );
      view.text += text;
    } else if (event.type === "closed") view.closed = true;
  };
  const deliverObserved = (view: View, event: MirrorPaneEvent) => {
    try {
      observe(view, event);
    } catch (error) {
      if (!(error instanceof ModelInvariant)) throw error;
      observationFailure ??= error;
    }
  };
  const subscribe = (pane: "%1" | "%2", id = `${pane}-initial`) => {
    trace.push({ type: "subscribe", pane, viewer: id });
    bump(pane);
    const view = {
      id,
      pane,
      closed: false,
      frozen: false,
      text: "",
      phase: "live" as const,
      generation: -1,
    } as View;
    views.set(id, view);
    view.handle = channel.subscribePane(pane === "%1" ? "pane.alpha" : "pane.beta", (event) => {
      if (mutationArmed && !mutationUsed && event.type === "delta" && mutation === "lost-output") {
        mutationUsed = true;
        return;
      }
      if (
        mutationArmed &&
        !mutationUsed &&
        event.type === "delta" &&
        mutation === "duplicate-output"
      ) {
        mutationUsed = true;
        deliverObserved(view, event);
      }
      if (
        mutationArmed &&
        !mutationUsed &&
        event.type === "cursor" &&
        mutation === "metadata-order"
      ) {
        mutationUsed = true;
        deliverObserved(view, { type: "delta", data: Buffer.from("bad") });
      }
      deliverObserved(view, event);
    });
    return view;
  };
  const produce = (pane: string, text: string) => {
    worlds.set(pane, worlds.get(pane)! + text);
    transport.produce(pane, text);
  };
  const settle = async (partition: number) => {
    for (let step = 0; step < 400; step++) {
      const progressed = transport.step(partition);
      await Promise.resolve();
      if (observationFailure) throw observationFailure;
      if (!progressed && transport.pending === 0) return;
    }
    throw new ModelHarnessError("Unbounded server work");
  };
  const checkpoint = () => {
    for (const view of views.values())
      if (!view.closed && !view.frozen) {
        invariant(
          view.phase === "live" && view.generation === generations.get(view.pane),
          "atomic-baseline",
          view.id,
          "incomplete baseline at drained checkpoint",
        );
        invariant(
          view.text === worlds.get(view.pane),
          "transcript",
          view.id,
          `expected ${JSON.stringify(worlds.get(view.pane))}, actual ${JSON.stringify(view.text)}`,
        );
      }
    invariant(
      transport.core.pendingCount === 0,
      "reply-slots",
      "channel",
      "unspent ordinary slots at drained checkpoint",
    );
  };
  let started = false;
  const start = channel.start().then(() => {
    started = true;
  });
  for (let turn = 0; turn < 500 && !started; turn++) {
    transport.step(0);
    await Promise.resolve();
  }
  if (!started) throw new ModelHarnessError("Initial discovery did not complete");
  await start;
  subscribe("%1");
  subscribe("%2");
  await settle(0);
  checkpoint();
  mutationArmed = true;
  try {
    for (const round of rounds) {
      trace.push({ type: "round", ...round, operation: round.operation });
      const view = active(round.pane)[0]!;
      produce(round.pane, round.before);
      await settle(round.partition);
      checkpoint();
      if (round.operation === "gap") {
        const oldCut = cuts.get(round.pane);
        bump(round.pane);
        transport.pause(round.pane);
        produce(round.pane, round.after);
        await settle(round.partition);
        invariant(
          cuts.get(round.pane) !== oldCut,
          "gap-recovery",
          view.id,
          "pause gap did not establish a new capture",
        );
        checkpoint();
        continue;
      }
      if (round.operation === "join") subscribe(round.pane, `round-${round.id}-join`);
      else {
        bump(round.pane);
        view.handle.reseed();
      }
      const previousCut = cuts.get(round.pane);
      const previousExecutions = transport.snapshotExecutions;
      if (round.operation === "capture-error") transport.failNextCapture = true;
      for (
        let step = 0;
        step < 200 && transport.snapshotExecutions === previousExecutions;
        step++
      ) {
        if (!transport.step(round.partition)) throw new ModelHarnessError("No pending capture");
        await Promise.resolve();
      }
      invariant(
        transport.snapshotExecutions > previousExecutions,
        "capture-cut",
        round.pane,
        "no capture execution",
      );
      if (round.operation === "capture-error") {
        const failedNonce = transport.arms.at(-1)!.nonce;
        await settle(round.partition);
        const timer = timers
          .filter((candidate) => !candidate.cancelled)
          .sort((a, b) => a.due - b.due)[0];
        if (!timer) throw new ModelHarnessError("Failed raw hook has no progress deadline");
        now = timer.due;
        timer.cancelled = true;
        timer.callback();
        await settle(round.partition);
        invariant(
          observations.some((event) => event.viewer === view.id && event.type === "fault"),
          "bounded-failure",
          view.id,
          "aborted raw capture did not fault within progress deadline",
        );
        invariant(
          transport.drains.some((drain) => drain.nonce === failedNonce && drain.reason === "fence"),
          "recovery",
          round.pane,
          "capture error lacked drain fence",
        );
        invariant(
          transport.core.pendingCount === 0 && transport.collectorIdle,
          "recovery",
          round.pane,
          "aborted collector retains drain debt",
        );
        break;
      }
      invariant(cuts.get(round.pane) !== previousCut, "capture-cut", round.pane, "no new cut");
      if (round.operation === "disconnect" || round.operation === "late-wire") {
        const late = transport.frames.map((frame) => frame.text).join("");
        const arms = transport.arms.length;
        transport.disconnect();
        if (round.operation === "late-wire") {
          const before = observations.length;
          transport.core.feed(late + "%output %1 stale-after-exit\n");
          if (observationFailure) throw observationFailure;
          invariant(
            observations.length === before,
            "stale-publication",
            view.id,
            "retired connection still emitted public events",
          );
        }
        invariant(
          transport.arms.length === arms && active(round.pane).length === 0,
          "disconnect",
          round.pane,
          "exit admitted new work or retained live subscriber",
        );
        break;
      }
      if (round.operation === "overflow") {
        const from = observations.length;
        for (let chunk = 0; chunk < 65; chunk++) produce(round.pane, "x".repeat(16_384));
        transport.deliver(round.partition);
        const target = now + 5001;
        for (let fired = 0; fired < 1000; fired++) {
          const timer = timers
            .filter((candidate) => !candidate.cancelled && candidate.due <= target)
            .sort((a, b) => a.due - b.due)[0];
          if (!timer) break;
          now = timer.due;
          timer.cancelled = true;
          timer.callback();
        }
        now = target;
        invariant(
          !observations
            .slice(from)
            .some((event) => event.type === "seed" || event.type === "delta"),
          "overflow",
          view.id,
          "published a partial over-budget stream",
        );
        invariant(
          observations
            .slice(from)
            .some((event) => event.type === "fault" || event.type === "closed"),
          "bounded-failure",
          view.id,
          "overflow did not fault or close within budget",
        );
        break;
      }
      produce(round.pane, round.after);
      const previousArms = transport.arms.length;
      if (round.operation === "cancel") {
        const sibling = round.pane === "%1" ? "%2" : "%1";
        bump(sibling);
        trace.push({ type: "reseed", pane: sibling, viewer: active(sibling)[0]!.id });
        active(sibling)[0]!.handle.reseed();
      }
      if (round.operation === "cancel" || round.operation === "freeze") {
        bump(round.pane);
        if (round.operation === "cancel") {
          view.closed = true;
          view.handle.close();
        } else {
          view.frozen = true;
          view.handle.freeze();
        }
        if (mutation === "stale-publication" && !mutationUsed) {
          mutationUsed = true;
          deliverObserved(view, { type: "delta", data: Buffer.from("stale") });
        }
      }
      if (round.operation === "cancel")
        invariant(
          transport.arms.length === previousArms,
          "admission",
          round.pane,
          "sibling armed before canceled owner drained",
        );
      await settle(round.partition);
      if (round.operation === "cancel")
        invariant(
          transport.drains.some(
            (drain) => drain.nonce === cuts.get(round.pane)?.nonce && drain.reason === "fence",
          ),
          "admission",
          round.pane,
          "canceled collector lacked ordinary drain fence",
        );
      if (round.operation === "cancel") {
        if (active(round.pane).length === 0) subscribe(round.pane, `round-${round.id}-replacement`);
      } else if (round.operation === "freeze") {
        bump(round.pane);
        view.frozen = false;
        view.handle.thaw();
      }
      await settle(round.partition);
      checkpoint();
      // Keep participant count bounded while retaining shared-generation rounds.
      for (const extra of active(round.pane).slice(1)) {
        extra.closed = true;
        extra.handle.close();
      }
      await settle(round.partition);
    }
    return {
      observations,
      trace,
      arms: transport.arms,
      drains: transport.drains,
      cuts: [...cuts.values()],
      commands: transport.commands,
      wire: transport.wire,
      reads: transport.reads,
      mutationUsed,
    };
  } catch (error) {
    if (error instanceof ModelInvariant)
      Object.assign(error, {
        trace: {
          observations,
          trace,
          commands: transport.commands,
          wire: transport.wire,
          reads: transport.reads,
          arms: transport.arms,
          drains: transport.drains,
        },
      });
    throw error;
  } finally {
    await channel.dispose();
  }
}

function random(seed: number) {
  let state = seed;
  return () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) >>> 8;
}
function generate(seed: number): Round[] {
  const next = random(seed);
  return Array.from({ length: 12 }, (_, id) => ({
    id,
    pane: next() % 2 ? "%1" : "%2",
    before: id.toString(36),
    after: String.fromCharCode(65 + id),
    partition: [0, 1, 37][next() % 3]!,
    operation:
      id === 11
        ? (["disconnect", "overflow", "capture-error"] as const)[seed % 3]!
        : (["reseed", "join", "cancel", "freeze", "gap"] as const)[next() % 5]!,
  }));
}

async function failure(
  rounds: readonly Round[],
  mutation?: Mutation,
): Promise<ModelInvariant | null> {
  try {
    await replay(rounds, mutation);
    return null;
  } catch (error) {
    if (error instanceof ModelInvariant) return error;
    throw error;
  }
}

async function reduce(
  rounds: readonly Round[],
  original: ModelInvariant,
  mutation?: Mutation,
): Promise<Round[]> {
  let result = [...rounds];
  for (
    let size = Math.max(1, Math.floor(result.length / 2));
    size >= 1;
    size = Math.floor(size / 2)
  ) {
    for (let start = 0; start < result.length; ) {
      const candidate = [...result.slice(0, start), ...result.slice(start + size)];
      const error = await failure(candidate, mutation);
      if (error?.code === original.code && error.victim === original.victim) result = candidate;
      else start += size;
    }
  }
  return result;
}

function identity() {
  const source = [
    "session-channel.ts",
    "control-channel.ts",
    "stock-pane-snapshot.ts",
    "session-channel-model.test.ts",
    "__tests__/session-model-channel.ts",
  ].map((name) => ({
    name,
    sha256: createHash("sha256")
      .update(readFileSync(new URL(name, import.meta.url)))
      .digest("hex"),
  }));
  return {
    gitHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    node: process.version,
    argv: process.argv,
    source,
  };
}

function receipt(
  seed: number,
  original: readonly Round[],
  error: ModelInvariant,
  extra: object = {},
): string {
  const path = join(mkdtempSync(join(tmpdir(), "tmux-session-model-")), "receipt.json");

  writeFileSync(
    path,
    JSON.stringify(
      {
        schema: 1,
        seed,
        lane: original.some((round) => round.operation === "late-wire") ? "fault" : "legal",
        ...identity(),
        original,
        invariant: { code: error.code, victim: error.victim, message: error.message },
        trace: (error as ModelInvariant & { trace?: unknown }).trace,
        ...extra,
      },
      null,
      2,
    ),
  );
  return path;
}

async function verify(seed: number): Promise<void> {
  const original = generate(seed);
  const error = await failure(original);
  if (!error) return;
  const path = receipt(seed, original, error);
  const reduced = await reduce(original, error);
  const reducedFailure = await failure(reduced);
  const repeatedOriginal = await failure(original);
  const repeatedReduced = await failure(reduced);
  for (const repeated of [reducedFailure, repeatedOriginal, repeatedReduced]) {
    if (repeated?.code !== error.code || repeated.victim !== error.victim)
      throw new ModelHarnessError(`Unstable failure receipt: ${path}`);
  }
  writeFileSync(
    path,
    JSON.stringify(
      {
        ...JSON.parse(readFileSync(path, "utf8")),
        reduced,
        reducedTrace: (reducedFailure as ModelInvariant & { trace?: unknown })?.trace,
      },
      null,
      2,
    ),
  );
  throw new Error(`SessionChannel model failure retained at ${path}`, { cause: error });
}

describe("SessionChannel transcript model", () => {
  it.each(Array.from({ length: 32 }, (_, index) => index + 1))(
    "preserves the SessionChannel transcript for recorded seed %i",
    verify,
  );
  // Keep all 128 additional seeds independently observable and bounded. A
  // single aggregate deadline conflates coverage instrumentation with failure.
  it.each(Array.from({ length: 128 }, (_, index) => index + 33))(
    "preserves the transcript in the wider campaign for recorded seed %i",
    verify,
    20_000,
  );
  it("covers every operation and wire partition choice in the recorded campaign", () => {
    const rounds = Array.from({ length: 32 }, (_, index) => generate(index + 1)).flat();
    expect([...new Set(rounds.map((round) => round.operation))].sort()).toEqual([
      "cancel",
      "capture-error",
      "disconnect",
      "freeze",
      "gap",
      "join",
      "overflow",
      "reseed",
    ]);
    expect([...new Set(rounds.map((round) => round.partition))].sort((a, b) => a - b)).toEqual([
      0, 1, 37,
    ]);
    expect([...new Set(rounds.map((round) => round.pane))].sort()).toEqual(["%1", "%2"]);
  });
  it("rejects deliberately injected stale wire after disconnect (fault lane)", async () => {
    await replay([
      { id: 1, pane: "%1", before: "a", after: "B", partition: 37, operation: "late-wire" },
    ]);
  });
  it.each<Mutation>(["lost-output", "duplicate-output", "stale-publication", "metadata-order"])(
    "detects and reduces %s through an independent invariant",
    async (mutation) => {
      const original: Round[] = [
        { id: 1, pane: "%1", before: "a", after: "B", partition: 1, operation: "cancel" },
        { id: 2, pane: "%2", before: "c", after: "D", partition: 0, operation: "join" },
        { id: 3, pane: "%1", before: "e", after: "F", partition: 37, operation: "reseed" },
      ];
      const error = await failure(original, mutation);
      expect(error).not.toBeNull();
      const path = receipt(73, original, error!, { mutation });
      const reduced = await reduce(original, error!, mutation);
      expect(reduced.length).toBeLessThan(original.length);
      const reducedError = await failure(reduced, mutation);
      expect([reducedError?.code, reducedError?.victim]).toEqual([error!.code, error!.victim]);
      expect((await failure(original, mutation))?.code).toBe(error!.code);
      expect((await failure(reduced, mutation))?.code).toBe(error!.code);
      await replay(original);
      await replay(reduced);
      writeFileSync(
        path,
        JSON.stringify(
          {
            ...JSON.parse(readFileSync(path, "utf8")),
            reduced,
            reducedTrace: (reducedError as ModelInvariant & { trace?: unknown }).trace,
            verifiedOriginal: true,
            verifiedReduced: true,
            unmutatedOriginalPassed: true,
            unmutatedReducedPassed: true,
          },
          null,
          2,
        ),
      );
      process.stdout.write(`Verified SessionChannel negative control: ${path}\n`);
    },
  );
  it("fails closed on an aborted raw capture and drains its failed hook group", async () => {
    await replay([
      { id: 1, pane: "%1", before: "a", after: "B", partition: 37, operation: "capture-error" },
    ]);
  });
  it("disconnects with an unread capture without publishing stale bytes", async () => {
    await replay([
      { id: 1, pane: "%1", before: "a", after: "B", partition: 37, operation: "disconnect" },
    ]);
  });
  it("bounds legal output overflow without publishing any partial capture or tail", async () => {
    await replay([
      { id: 1, pane: "%1", before: "a", after: "B", partition: 37, operation: "overflow" },
    ]);
  });
  it("drives an owned post-capture overtaking schedule through the real SessionChannel", async () => {
    const schedule: Round[] = [
      { id: 1, pane: "%1", before: "a", after: "B", partition: 1, operation: "reseed" },
    ];
    const result = await replay(schedule);
    const path = join(
      mkdtempSync(join(tmpdir(), "tmux-session-model-overtaking-")),
      "receipt.json",
    );
    writeFileSync(
      path,
      JSON.stringify({ schema: 1, lane: "legal", ...identity(), schedule, ...result }, null, 2),
    );
    process.stdout.write(`Successful overtaking model receipt: ${path}\n`);
  });
  it("cancels A while B is queued and admits B only after the real ordinary fence", async () => {
    const schedule: Round[] = [
      { id: 1, pane: "%1", before: "a", after: "B", partition: 37, operation: "cancel" },
    ];
    const result = await replay(schedule);
    const path = join(mkdtempSync(join(tmpdir(), "tmux-session-model-cancel-")), "receipt.json");
    writeFileSync(
      path,
      JSON.stringify({ schema: 1, lane: "legal", ...identity(), schedule, ...result }, null, 2),
    );
    process.stdout.write(`Successful cancellation model receipt: ${path}\n`);
  });
  it("publishes all shared subscriber metadata before the retained tail", async () => {
    await replay([{ id: 1, pane: "%1", before: "a", after: "B", partition: 0, operation: "join" }]);
  });
  it("freezes the old generation and establishes a fresh baseline on thaw", async () => {
    await replay([
      { id: 1, pane: "%2", before: "a", after: "B", partition: 1, operation: "freeze" },
    ]);
  });
});
