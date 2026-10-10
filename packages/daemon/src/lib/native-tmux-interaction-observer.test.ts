import { describe, expect, it, vi } from "vitest";
import {
  NativeTmuxInteractionObserver,
  validateNativeJournalBatch,
  type NativeJournalObserverEvent,
  type NativeJournalObserverIo,
} from "./native-tmux-interaction-observer.ts";
import {
  NativeJournalBatchSchemaZ,
  NativeJournalRecordSchemaZ,
  NativeJournalUint64SchemaZ,
  type NativeJournalCapability,
} from "@tmux-ide/contracts";
const serverEpoch = "a729e244-2531-430c-a947-2dd0a68b0341";
const journalEpoch = "973ab7cb-f8a7-471e-87e8-b40a7da2bf29";
const otherEpoch = "000ba6a9-2bd1-4a68-80db-1b07628c19d6";
const capability: NativeJournalCapability = {
  schemaVersion: 2,
  type: "capability",
  serverEpoch,
  journalEpoch,
  enabled: true,
  coverage: [
    "command-outcome-v1",
    "pty-enqueue-v1",
    "capture-produced-v1",
    "cooperative-operation-v1",
    "pane-identity-v1",
  ],
  capacity: 4096,
  maxBatch: 256,
  maxWaiters: 4,
  waitingReaders: 0,
  degraded: 0,
};
const record = (sequence: string) => ({
  sequence,
  commandId: "0",
  issuerId: "0",
  monotonicUs: "1",
  count: "0",
  targetId: 0,
  targetBirthId: "1",
  kind: 1,
  outcome: 1,
  flags: 1,
  requestId: "0",
  parentCommandId: "0",
  transport: 0,
  derivation: 0,
  correlation: null,
});
const batch = (sequences: string[], extra: Record<string, unknown> = {}) => ({
  schemaVersion: 2,
  type: "batch",
  serverEpoch,
  journalEpoch,
  oldest: "1",
  newest: sequences.at(-1) ?? "0",
  gap: null,
  records: sequences.map(record),
  next: sequences.at(-1) ?? "0",
  degraded: 0,
  ...extra,
});
const pending = (signal: AbortSignal) =>
  new Promise<string>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function fixture(
  run: (args: readonly string[], signal: AbortSignal) => Promise<string>,
  options: Partial<ConstructorParameters<typeof NativeTmuxInteractionObserver>[0]> = {},
) {
  const events: NativeJournalObserverEvent[] = [];
  const delays: number[] = [];
  const releases: Array<() => void> = [];
  const io: NativeJournalObserverIo = {
    runTmux: vi.fn(run),
    delay: (ms, signal) => {
      delays.push(ms);
      return new Promise<void>((resolve, reject) => {
        releases.push(resolve);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  };
  const observer = new NativeTmuxInteractionObserver({
    tmuxAuthority: { executablePath: "/unused", socketSelector: { kind: "path", path: "/unused" } },
    nativeServerIdentity: { pid: "1", startTime: "1" },
    onEvent: (event) => events.push(event),
    io,
    ...options,
  });
  return { observer, events, io, delays, releases };
}
describe("native journal wire", () => {
  it("rejects malformed and overflow uint64 without throwing inside safeParse", () => {
    for (const invalid of ["-1", "01", "1.0", "abc", "18446744073709551616", "9".repeat(1000)])
      expect(NativeJournalUint64SchemaZ.safeParse(invalid).success).toBe(false);
    expect(NativeJournalUint64SchemaZ.parse("18446744073709551615")).toBe("18446744073709551615");
  });
  it("rejects content, oversized batches and fabricated command/effect counts", () => {
    expect(NativeJournalRecordSchemaZ.safeParse({ ...record("1"), text: "private" }).success).toBe(
      false,
    );
    expect(NativeJournalRecordSchemaZ.safeParse({ ...record("1"), count: "2" }).success).toBe(
      false,
    );
    expect(NativeJournalRecordSchemaZ.safeParse({ ...record("1"), kind: 5 }).success).toBe(false);
    expect(
      NativeJournalBatchSchemaZ.safeParse(
        batch(Array.from({ length: 65 }, (_, i) => String(i + 1))),
      ).success,
    ).toBe(false);
  });
  it("keeps64 widest metadata records below the runner64KiB buffer", () => {
    const max = "18446744073709551615";
    const wide = {
      ...record(max),
      commandId: max,
      issuerId: max,
      monotonicUs: max,
      targetId: 4294967295,
      targetBirthId: max,
      requestId: max,
      parentCommandId: max,
      transport: 2,
      derivation: 3,
      correlation: serverEpoch,
    };
    const data = {
      ...batch([]),
      oldest: max,
      newest: max,
      next: max,
      records: Array.from({ length: 64 }, () => wide),
    };
    expect(NativeJournalBatchSchemaZ.safeParse(data).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThan(64 * 1024);
  });
  it("requires exact contiguous ordering, cursor advance and overflow range", () => {
    const cursor = { serverEpoch, journalEpoch, sequence: "0" };
    expect(() =>
      validateNativeJournalBatch(NativeJournalBatchSchemaZ.parse(batch(["1", "3"])), cursor),
    ).toThrow();
    expect(() =>
      validateNativeJournalBatch(
        NativeJournalBatchSchemaZ.parse(
          batch(["3"], { oldest: "3", gap: { from: "1", through: "2" } }),
        ),
        cursor,
      ),
    ).not.toThrow();
    expect(() =>
      validateNativeJournalBatch(
        NativeJournalBatchSchemaZ.parse(batch(["3"], { oldest: "3", gap: null })),
        cursor,
      ),
    ).toThrow();
    expect(() =>
      validateNativeJournalBatch(
        NativeJournalBatchSchemaZ.parse(batch(["1"], { next: "2" })),
        cursor,
      ),
    ).toThrow();
  });
});
describe("native observer lifecycle", () => {
  it("probes without enabling by default", async () => {
    const f = fixture(async () => JSON.stringify({ ...capability, enabled: false }));
    expect(await f.observer.start()).toBe("disabled");
    expect(f.io.runTmux).toHaveBeenCalledTimes(1);
    await f.observer.dispose();
  });
  it("explicitly enables and aborts the single blocking64record reader", async () => {
    let aborted = false;
    const f = fixture(
      async (args, signal) => {
        if (args.includes("-V")) return JSON.stringify({ ...capability, enabled: false });
        if (args.includes("-e")) return JSON.stringify(capability);
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        return pending(signal);
      },
      { enable: true },
    );
    expect(await f.observer.start()).toBe("ready");
    expect(f.io.runTmux).toHaveBeenLastCalledWith(
      ["tmux-ide-events", "-r", "-w", "-E", journalEpoch, "-a", "0", "-n", "64"],
      expect.any(AbortSignal),
    );
    await f.observer.dispose();
    expect(aborted).toBe(true);
    expect(f.observer.status).toBe("disposed");
  });
  it("keeps distinct sequence records with unknown0command/issuer IDs", async () => {
    let sent = false;
    const f = fixture(async (args, signal) =>
      args.includes("-V")
        ? JSON.stringify(capability)
        : sent
          ? pending(signal)
          : ((sent = true), JSON.stringify(batch(["1", "2"]))),
    );
    await f.observer.start();
    await flush();
    const delivered = f.events.find((event) => event.type === "batch");
    expect(delivered?.type === "batch" && delivered.batch.records).toHaveLength(2);
    expect(f.observer.cursor?.sequence).toBe("2");
    await f.observer.dispose();
  });
  it("publishes precise overflow before records", async () => {
    let sent = false;
    const f = fixture(async (args, signal) =>
      args.includes("-V")
        ? JSON.stringify(capability)
        : sent
          ? pending(signal)
          : ((sent = true),
            JSON.stringify(batch(["3", "4"], { oldest: "3", gap: { from: "1", through: "2" } }))),
    );
    await f.observer.start();
    await flush();
    expect(f.events.filter((event) => event.type !== "state").map((event) => event.type)).toEqual([
      "gap",
      "batch",
    ]);
    await f.observer.dispose();
  });
  it("stops on degraded immediate response without spinning", async () => {
    const f = fixture(async (args) =>
      JSON.stringify(args.includes("-V") ? capability : batch([], { degraded: 7 })),
    );
    await f.observer.start();
    await flush();
    expect(f.observer.status).toBe("degraded");
    expect(f.io.runTmux).toHaveBeenCalledTimes(2);
    expect(f.delays).toEqual([]);
    await f.observer.dispose();
  });
  it("never follows a replacement server or enables a mismatched saved authority", async () => {
    const f = fixture(
      async () => JSON.stringify({ ...capability, serverEpoch: otherEpoch, enabled: false }),
      { enable: true, cursor: { serverEpoch, journalEpoch, sequence: "0" } },
    );
    expect(await f.observer.start()).toBe("retired");
    expect(f.io.runTmux).toHaveBeenCalledTimes(1);
    await f.observer.dispose();
  });
  it("resets journal epoch explicitly with bounded rearm delay", async () => {
    let reset = false;
    const f = fixture(async (args, signal) =>
      args.includes("-V")
        ? JSON.stringify(capability)
        : reset
          ? pending(signal)
          : ((reset = true),
            JSON.stringify({
              schemaVersion: 2,
              type: "reset",
              serverEpoch,
              journalEpoch: otherEpoch,
            })),
    );
    await f.observer.start();
    await flush();
    expect(f.observer.cursor).toEqual({ serverEpoch, journalEpoch: otherEpoch, sequence: "0" });
    expect(f.delays).toEqual([1000]);
    f.releases.shift()!();
    await flush();
    await f.observer.dispose();
  });
  it("bounds persistent failures and empty wakeups with exponential backoff", async () => {
    const f = fixture(
      async (args) => {
        if (args.includes("-V")) return JSON.stringify(capability);
        throw new Error("private output must not escape");
      },
      { timing: { retryMs: 10, maxRetryMs: 40 } },
    );
    await f.observer.start();
    await flush();
    for (let i = 0; i < 4; i++) {
      f.releases.shift()!();
      await flush();
    }
    expect(f.delays).toEqual([10, 20, 40, 40, 40]);
    expect(JSON.stringify(f.events)).not.toContain("private");
    await f.observer.dispose();
  });
  it("rejects malformed metadata without advancing or publishing", async () => {
    const f = fixture(async (args) =>
      JSON.stringify(args.includes("-V") ? capability : batch(["2"])),
    );
    await f.observer.start();
    await flush();
    expect(f.observer.cursor?.sequence).toBe("0");
    expect(f.events.some((event) => event.type === "batch")).toBe(false);
    expect(f.delays).toEqual([1000]);
    await f.observer.dispose();
  });
  it("stops when synchronous ingestion throws, with no redelivery loop", async () => {
    const f = fixture(
      async (args) => JSON.stringify(args.includes("-V") ? capability : batch(["1"])),
      {
        onEvent(event) {
          if (event.type === "batch") throw new Error("consumer failure");
        },
      },
    );
    await f.observer.start();
    await flush();
    expect(f.observer.status).toBe("consumer-failed");
    expect(f.io.runTmux).toHaveBeenCalledTimes(2);
    await f.observer.dispose();
  });
  it("does not emit late probe results after disposal", async () => {
    let resolve!: (value: string) => void;
    const f = fixture(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    const started = f.observer.start();
    const disposal = f.observer.dispose();
    const count = f.events.length;
    resolve(JSON.stringify(capability));
    await started;
    await disposal;
    expect(f.events).toHaveLength(count);
  });
  it("rejects version1 before enable and accepts explicit birth exhaustion", async () => {
    const old = fixture(async () => JSON.stringify({ ...capability, schemaVersion: 1 }), {
      enable: true,
    });
    expect(await old.observer.start()).toBe("incompatible");
    expect(old.io.runTmux).toHaveBeenCalledTimes(1);
    await old.observer.dispose();
    const exhausted = fixture(async (args) =>
      JSON.stringify(args.includes("-V") ? capability : batch([], { degraded: 16 })),
    );
    await exhausted.observer.start();
    await flush();
    expect(exhausted.observer.status).toBe("degraded");
    await exhausted.observer.dispose();
    expect(
      NativeJournalRecordSchemaZ.safeParse({ ...record("1"), flags: 0, targetBirthId: "1" })
        .success,
    ).toBe(false);
  });
  it("rejects unknown coverage before enabling", async () => {
    const f = fixture(
      async () => JSON.stringify({ ...capability, enabled: false, coverage: ["unknown-version"] }),
      { enable: true },
    );
    expect(await f.observer.start()).toBe("incompatible");
    expect(f.io.runTmux).toHaveBeenCalledTimes(1);
    await f.observer.dispose();
  });
  it("renews a bounded idle lease without reporting failure or a gap", async () => {
    let aborted = false;
    const f = fixture(
      async (args, signal) => {
        if (args.includes("-V")) return JSON.stringify(capability);
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        return pending(signal);
      },
      { timing: { waitMs: 5 } },
    );
    await f.observer.start();
    await vi.waitFor(
      () => expect(vi.mocked(f.io.runTmux).mock.calls.length).toBeGreaterThanOrEqual(3),
      {
        timeout: 200,
        interval: 5,
      },
    );
    expect(aborted).toBe(true);
    expect(f.observer.status).toBe("ready");
    expect(f.delays).toEqual([]);
    expect(
      f.events.some(
        (event) => event.type === "gap" || (event.type === "state" && event.status === "retrying"),
      ),
    ).toBe(false);
    await f.observer.dispose();
  });
  it("rejects asynchronous ingestion instead of accumulating promises", async () => {
    const f = fixture(async () => JSON.stringify(capability), { onEvent: async () => undefined });
    expect(await f.observer.start()).toBe("consumer-failed");
    expect(f.io.runTmux).not.toHaveBeenCalled();
    await f.observer.dispose();
  });
});

describe("observation batching", () => {
  it.each([16, 32] as const)(
    "drains a quiet trailing record after one fixed %ims window",
    async (window) => {
      let reads = 0;
      const f = fixture(
        async (args, signal) => {
          if (args.includes("-V")) return JSON.stringify(capability);
          reads++;
          if (reads === 1) return JSON.stringify(batch(["1"]));
          if (reads === 2) return JSON.stringify(batch(["2"]));
          return pending(signal);
        },
        { timing: { observationBatchMs: window } },
      );
      await f.observer.start();
      await flush();
      expect(reads).toBe(1);
      expect(f.delays).toEqual([window]);
      await flush();
      expect(f.delays).toEqual([window]); // no sliding timer or parallel polling
      f.releases[0]!();
      await flush();
      expect(reads).toBe(2);
      expect(f.observer.cursor?.sequence).toBe("2");
      expect(f.events.filter((e) => e.type === "batch")).toHaveLength(2);
      f.releases[1]!();
      await flush();
      expect(reads).toBe(3); // parks even when no subsequent traffic exists
      expect(f.delays).toEqual([window, window]);
      await f.observer.dispose();
    },
  );
  it("drains a burst larger than64 immediately before waiting at the caught-up cursor", async () => {
    let reads = 0;
    const f = fixture(
      async (args, signal) => {
        if (args.includes("-V")) return JSON.stringify(capability);
        reads++;
        if (reads === 1)
          return JSON.stringify(
            batch(
              Array.from({ length: 64 }, (_, i) => String(i + 1)),
              { newest: "65" },
            ),
          );
        if (reads === 2) return JSON.stringify(batch(["65"]));
        return pending(signal);
      },
      { timing: { observationBatchMs: 32 } },
    );
    await f.observer.start();
    await flush();
    expect(reads).toBe(2);
    expect(f.delays).toEqual([32]);
    expect(f.observer.cursor?.sequence).toBe("65");
    expect(
      f.events
        .filter((e) => e.type === "batch")
        .flatMap((e) => (e.type === "batch" ? e.batch.records : [])),
    ).toHaveLength(65);
    expect(
      vi
        .mocked(f.io.runTmux)
        .mock.calls.filter(([args]) => args.includes("-r"))
        .every(([args]) => args.at(-1) === "64"),
    ).toBe(true);
    await f.observer.dispose();
  });
  it("cancels the window immediately and never dispatches after disposal or a late timer", async () => {
    const f = fixture(
      async (args) => JSON.stringify(args.includes("-V") ? capability : batch(["1"])),
      { timing: { observationBatchMs: 32 } },
    );
    await f.observer.start();
    await flush();
    expect(f.delays).toEqual([32]);
    const calls = vi.mocked(f.io.runTmux).mock.calls.length;
    await f.observer.dispose();
    f.releases[0]!();
    await flush();
    expect(f.io.runTmux).toHaveBeenCalledTimes(calls);
    expect(f.observer.status).toBe("disposed");
  });
  it.each(["reset", "gap", "degraded"])(
    "preserves %s reporting after a batching window",
    async (kind) => {
      let reads = 0;
      const f = fixture(
        async (args, signal) => {
          if (args.includes("-V")) return JSON.stringify(capability);
          reads++;
          if (reads === 1) return JSON.stringify(batch(["1"]));
          if (reads === 2) {
            if (kind === "reset")
              return JSON.stringify({
                schemaVersion: 2,
                type: "reset",
                serverEpoch,
                journalEpoch: otherEpoch,
              });
            if (kind === "gap")
              return JSON.stringify(
                batch(["3"], { oldest: "3", gap: { from: "2", through: "2" } }),
              );
            return JSON.stringify(batch(["2"], { degraded: 1 }));
          }
          return pending(signal);
        },
        { timing: { observationBatchMs: 16 } },
      );
      await f.observer.start();
      await flush();
      f.releases[0]!();
      await flush();
      if (kind === "reset") {
        expect(f.events.some((e) => e.type === "reset")).toBe(true);
        expect(f.observer.cursor?.journalEpoch).toBe(otherEpoch);
        expect(f.delays).toEqual([16, 1000]); // existing reset retry, no extra batching
      } else if (kind === "gap") {
        const gapIndex = f.events.findIndex((e) => e.type === "gap");
        expect(gapIndex).toBeGreaterThan(0);
        expect(f.events[gapIndex + 1]?.type).toBe("batch");
        expect(f.observer.cursor?.sequence).toBe("3");
      } else {
        expect(f.observer.status).toBe("degraded");
        expect(f.delays).toEqual([16]);
      }
      await f.observer.dispose();
    },
  );
  it("rejects unbounded or unreviewed experimental windows", () => {
    for (const value of [-1, 1, 8, 33, Infinity, NaN])
      expect(() =>
        fixture(async () => "", { timing: { observationBatchMs: value as 16 } }),
      ).toThrow("batching window");
  });
});

describe("observation batching defaults and failure", () => {
  it.each([undefined, 0] as const)("uses the selected %s batching policy", async (window) => {
    let reads = 0;
    const f = fixture(
      async (args, signal) => {
        if (args.includes("-V")) return JSON.stringify(capability);
        return ++reads === 1 ? JSON.stringify(batch(["1"])) : pending(signal);
      },
      { timing: { observationBatchMs: window } },
    );
    await f.observer.start();
    await flush();
    if (window === undefined) {
      expect(reads).toBe(1);
      expect(f.delays).toEqual([32]);
      f.releases[0]!();
      await flush();
    } else {
      expect(f.delays).toEqual([]);
    }
    expect(reads).toBe(2);
    await f.observer.dispose();
  });
  it.each([16, 32] as const)("schedules no %ims window after consumer failure", async (window) => {
    const f = fixture(
      async (args) => JSON.stringify(args.includes("-V") ? capability : batch(["1"])),
      {
        timing: { observationBatchMs: window },
        onEvent(event) {
          if (event.type === "batch") throw new Error("consumer failed");
        },
      },
    );
    await f.observer.start();
    await flush();
    expect(f.observer.status).toBe("consumer-failed");
    expect(f.delays).toEqual([]);
    expect(vi.mocked(f.io.runTmux).mock.calls.filter(([args]) => args.includes("-r"))).toHaveLength(
      1,
    );
    await f.observer.dispose();
  });
});

it("refuses a lazy preflight epoch replacement before issuing enable", async () => {
  const seen: string[][] = [];
  const f = fixture(
    async (args) => {
      seen.push([...args]);
      return JSON.stringify({ ...capability, enabled: false });
    },
    { enable: true, expectedServerEpoch: otherEpoch },
  );
  try {
    await f.observer.start();
    expect(seen).toEqual([["tmux-ide-events", "-V"]]);
  } finally {
    await f.observer.dispose();
  }
});
