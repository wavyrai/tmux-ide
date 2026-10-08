import { describe, expect, it } from "vitest";
import { StockPaneSnapshot } from "./stock-pane-snapshot.ts";
import type { MirrorPaneEvent } from "./events.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (data: Uint8Array) => new TextDecoder().decode(data);
const snapshotEvents = (): MirrorPaneEvent[] => [
  { type: "reset", cols: 80, rows: 24 },
  { type: "seed", data: encode("BEFORE") },
  { type: "cursor", x: 6, y: 0, observedModes: { bracketedPaste: false } },
];
function fixture(twoViewers = false, limits?: { maxBytes?: number; maxChunks?: number }) {
  const first = {};
  const second = {};
  const context = {
    paneId: "%1",
    incarnation: 1,
    layoutGeneration: 1,
    participants: twoViewers ? [first, second] : [first],
  };
  const transaction = new StockPaneSnapshot(context, limits);
  const received: Array<{ participant: object; event: MirrorPaneEvent }> = [];
  const batches = context.participants.map((participant) => ({
    participant,
    events: snapshotEvents(),
  }));
  const emit = (participant: object, event: MirrorPaneEvent) =>
    received.push({ participant, event });
  return { context, transaction, received, batches, emit, first, second };
}

describe("stock pane snapshot transaction (not SessionChannel admission)", () => {
  it("discards pre-pause output and retains overtaking post-pause output until publication", () => {
    const f = fixture();
    expect(f.transaction.acceptOutput("%1", encode("PRE-PAUSE"), f.context)).toBe("discarded");
    expect(f.transaction.observePause(f.context)).toBe(true);
    expect(f.transaction.acceptOutput("%1", encode("AFTER"), f.context)).toBe("held");
    expect(f.received).toEqual([]);
    expect(f.transaction.publish(f.batches, () => f.context, f.emit)).toBe(true);
    expect(f.received.map(({ event }) => event.type)).toEqual(["reset", "seed", "cursor", "delta"]);
    expect(
      f.received.flatMap(({ event }) => (event.type === "delta" ? [decode(event.data)] : [])),
    ).toEqual(["AFTER"]);
    expect(f.transaction.acceptOutput("%1", encode("NEXT"), f.context)).toBe("live");
  });

  it.each(["incarnation", "layout", "join", "leave"])(
    "rejects committed routing after a changed %s context",
    (change) => {
      const f = fixture();
      f.transaction.observePause(f.context);
      expect(f.transaction.publish(f.batches, () => f.context, f.emit)).toBe(true);
      const next = { ...f.context };
      if (change === "incarnation") next.incarnation++;
      if (change === "layout") next.layoutGeneration++;
      if (change === "join") next.participants = [...next.participants, {}];
      if (change === "leave") next.participants = [];
      const delivered = f.received.length;
      expect(f.transaction.acceptOutput("%1", encode("STALE"), next)).toBe("invalid");
      expect(f.transaction.acceptOutput("%1", encode("LATE"), f.context)).toBe("invalid");
      expect(f.received).toHaveLength(delivered);
    },
  );

  it("revokes committed routing without retracting already delivered events", () => {
    const f = fixture();
    f.transaction.observePause(f.context);
    expect(f.transaction.publish(f.batches, () => f.context, f.emit)).toBe(true);
    expect(f.transaction.acceptOutput("%1", encode("CURRENT"), f.context)).toBe("live");
    const delivered = [...f.received];
    f.transaction.invalidate();
    expect(f.transaction.acceptOutput("%1", encode("LATE"), f.context)).toBe("invalid");
    expect(f.transaction.publish(f.batches, () => f.context, f.emit)).toBe(false);
    expect(f.received).toEqual(delivered);
  });

  it.each(["before", "after-callback"])(
    "fails closed when current context becomes unavailable %s publication",
    (when) => {
      const f = fixture(true);
      f.transaction.observePause(f.context);
      f.transaction.acceptOutput("%1", encode("TAIL"), f.context);
      let unavailable = when === "before";
      expect(
        f.transaction.publish(
          f.batches,
          () => {
            if (unavailable) throw new Error("pane retired");
            return f.context;
          },
          (participant, event) => {
            f.emit(participant, event);
            unavailable = true;
          },
        ),
      ).toBe(false);
      expect(f.transaction.failureReason).toBe("context-unavailable");
      expect(f.received.map(({ event }) => event.type)).toEqual(when === "before" ? [] : ["reset"]);
      expect(f.transaction.bufferedBytes).toBe(0);
      expect(f.transaction.acceptOutput("%1", encode("LATE"), f.context)).toBe("invalid");
      expect(f.transaction.publish(f.batches, () => f.context, f.emit)).toBe(false);
    },
  );

  it("gives every viewer the snapshot metadata before replaying its tail exactly once", () => {
    const f = fixture(true);
    f.transaction.observePause(f.context);
    f.transaction.acceptOutput("%1", encode("\rAFTER\u001b[?2004h"), f.context);
    expect(f.transaction.publish(f.batches, () => f.context, f.emit)).toBe(true);
    for (const participant of f.context.participants) {
      expect(
        f.received
          .filter((event) => event.participant === participant)
          .map(({ event }) => event.type),
      ).toEqual(["reset", "seed", "cursor", "delta"]);
    }
    expect(f.received.slice(0, 6).every(({ event }) => event.type !== "delta")).toBe(true);
    const count = f.received.length;
    f.transaction.publish(f.batches, () => f.context, f.emit);
    expect(f.received).toHaveLength(count);
  });

  it("ignores sibling output and owns a copy of buffered bytes", () => {
    const f = fixture();
    f.transaction.observePause(f.context);
    expect(f.transaction.acceptOutput("%2", encode("SIBLING"), f.context)).toBe("unrelated");
    const bytes = encode("TAIL");
    f.transaction.acceptOutput("%1", bytes, f.context);
    bytes.fill(88);
    f.transaction.publish(f.batches, () => f.context, f.emit);
    expect(
      f.received.flatMap(({ event }) => (event.type === "delta" ? [decode(event.data)] : [])),
    ).toEqual(["TAIL"]);
  });

  it.each(["pane", "incarnation", "layout", "join", "leave"])(
    "rejects a changed %s context",
    (change) => {
      const f = fixture();
      f.transaction.observePause(f.context);
      f.transaction.acceptOutput("%1", encode("TAIL"), f.context);
      const next = { ...f.context };
      if (change === "pane") next.paneId = "%2";
      if (change === "incarnation") next.incarnation++;
      if (change === "layout") next.layoutGeneration++;
      if (change === "join") next.participants = [...next.participants, {}];
      if (change === "leave") next.participants = [];
      expect(f.transaction.publish(f.batches, () => next, f.emit)).toBe(false);
      expect(f.received).toEqual([]);
    },
  );

  it.each(["byte", "chunk"])("rejects %s overflow without publishing a truncated tail", (bound) => {
    const f = fixture(false, bound === "byte" ? { maxBytes: 3 } : { maxChunks: 1 });
    f.transaction.observePause(f.context);
    expect(f.transaction.acceptOutput("%1", encode("ONE"), f.context)).toBe("held");
    expect(f.transaction.acceptOutput("%1", encode("X"), f.context)).toBe("invalid");
    expect(f.transaction.publish(f.batches, () => f.context, f.emit)).toBe(false);
    expect(f.received).toEqual([]);
    expect(f.transaction.bufferedBytes).toBe(0);
  });

  it.each(["cancel", "repause"])("invalidates retained output on %s", (action) => {
    const f = fixture();
    f.transaction.observePause(f.context);
    f.transaction.acceptOutput("%1", encode("OLD"), f.context);
    if (action === "cancel") f.transaction.invalidate();
    else expect(f.transaction.observePause(f.context)).toBe(false);
    expect(f.transaction.publish(f.batches, () => f.context, f.emit)).toBe(false);
    expect(f.received).toEqual([]);
  });

  it("retains reentrant output until after all snapshot metadata", () => {
    const f = fixture(true);
    f.transaction.observePause(f.context);
    f.transaction.acceptOutput("%1", encode("FIRST"), f.context);
    expect(
      f.transaction.publish(
        f.batches,
        () => f.context,
        (participant, event) => {
          f.emit(participant, event);
          if (participant === f.first && event.type === "reset") {
            f.transaction.acceptOutput("%1", encode("REENTRANT"), f.context);
          }
        },
      ),
    ).toBe(true);
    for (const participant of f.context.participants) {
      expect(
        f.received
          .filter((event) => event.participant === participant)
          .flatMap(({ event }) => (event.type === "delta" ? [decode(event.data)] : [])),
      ).toEqual(["FIRST", "REENTRANT"]);
    }
  });

  it("stops publication immediately if a callback changes participant ownership", () => {
    const f = fixture(true);
    f.transaction.observePause(f.context);
    let context = f.context;
    expect(
      f.transaction.publish(
        f.batches,
        () => context,
        (participant, event) => {
          f.emit(participant, event);
          context = { ...context, participants: [f.second] };
        },
      ),
    ).toBe(false);
    expect(f.received.map(({ event }) => event.type)).toEqual(["reset"]);
  });

  it("contains consumer exceptions and cannot replay after failure", () => {
    const f = fixture();
    f.transaction.observePause(f.context);
    expect(
      f.transaction.publish(
        f.batches,
        () => f.context,
        () => {
          throw new Error("consumer closed");
        },
      ),
    ).toBe(false);
    expect(f.transaction.publish(f.batches, () => f.context, f.emit)).toBe(false);
    expect(f.received).toEqual([]);
  });

  it("refuses publication without an observed pause", () => {
    const f = fixture();
    expect(f.transaction.publish(f.batches, () => f.context, f.emit)).toBe(false);
    expect(f.received).toEqual([]);
  });

  it("isolates replay bytes from a sibling subscriber that mutates its event", () => {
    const f = fixture(true);
    f.transaction.observePause(f.context);
    f.transaction.acceptOutput("%1", encode("ORIGINAL"), f.context);
    const seen: string[] = [];
    expect(
      f.transaction.publish(
        f.batches,
        () => f.context,
        (participant, event) => {
          if (event.type !== "delta") return;
          seen.push(decode(event.data));
          if (participant === f.first) event.data.fill(88);
        },
      ),
    ).toBe(true);
    expect(seen).toEqual(["ORIGINAL", "ORIGINAL"]);
  });

  it.each(["missing", "duplicate", "foreign"])(
    "rejects %s snapshot participants before emitting",
    (kind) => {
      const f = fixture(true);
      f.transaction.observePause(f.context);
      const batches =
        kind === "missing"
          ? f.batches.slice(0, 1)
          : kind === "duplicate"
            ? [f.batches[0]!, f.batches[0]!]
            : [f.batches[0]!, { participant: {}, events: snapshotEvents() }];
      expect(f.transaction.publish(batches, () => f.context, f.emit)).toBe(false);
      expect(f.received).toEqual([]);
    },
  );

  it("does not permit callers to disable the bounded buffer contract", () => {
    const f = fixture();
    expect(() => new StockPaneSnapshot(f.context, { maxBytes: 1024 * 1024 + 1 })).toThrow();
    expect(() => new StockPaneSnapshot(f.context, { maxChunks: 513 })).toThrow();
    expect(
      () => new StockPaneSnapshot(f.context, { maxBytes: Number.POSITIVE_INFINITY }),
    ).toThrow();
  });

  it("rejects incomplete or already-replayed snapshot batches", () => {
    const f = fixture();
    f.transaction.observePause(f.context);
    expect(
      f.transaction.publish(
        [
          {
            participant: f.first,
            events: [...snapshotEvents(), { type: "delta", data: encode("INVALID") }],
          },
        ],
        () => f.context,
        f.emit,
      ),
    ).toBe(false);
    expect(f.received).toEqual([]);
  });
});
