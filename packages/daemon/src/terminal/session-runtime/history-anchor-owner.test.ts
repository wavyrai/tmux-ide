import { expect, it } from "vitest";
import { blankTerminalReplicaSnapshot } from "@tmux-ide/core";
import type {
  CanonicalTerminalReplicaSeed,
  CanonicalTerminalReplicaPatch,
  TerminalReplicaPatchPayload,
} from "@tmux-ide/contracts";
import { HistoryAnchorOwner } from "./history-anchor-owner.ts";
const blank = blankTerminalReplicaSnapshot(4, 2);
const seed = (): CanonicalTerminalReplicaSeed => ({
  type: "terminal.seed",
  workspaceName: "w",
  semanticPaneId: "p",
  generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  incarnation: "i",
  revision: 0,
  stateHash: "0000000000000000",
  hashAlgorithm: "fnv1a64-v1",
  cols: 4,
  rows: 2,
  snapshot: { ...blank, history: Array(4).fill(blank.grid[0]) },
});
function patch(
  previous: CanonicalTerminalReplicaSeed | CanonicalTerminalReplicaPatch,
  payload: TerminalReplicaPatchPayload,
): CanonicalTerminalReplicaPatch {
  return {
    ...previous,
    type: "terminal.patch",
    baseRevision: previous.revision,
    revision: previous.revision + 1,
    stateHash: (previous.revision + 1).toString(16).padStart(16, "0"),
    patch: payload,
  };
}
function token(owner: HistoryAnchorOwner, s: CanonicalTerminalReplicaSeed, index = 2) {
  const r = owner.capture(s, index);
  expect(r.status).toBe("captured");
  if (r.status !== "captured") throw Error("capture");
  return r.token;
}
it("distinguishes duplicate text by ordinal and survives trim before anchor, not trim of anchor", () => {
  const owner = new HistoryAnchorOwner(),
    s = seed();
  owner.observe(s);
  const t = token(owner, s);
  const first = token(owner, s, 0);
  const p = patch(s, { rows: [], historyDelta: { trim: 1, append: [blank.grid[0]!] } });
  owner.observe(p);
  expect(owner.resolve(p, t)).toEqual({
    status: "resolved",
    proof: {
      workspaceName: p.workspaceName,
      semanticPaneId: p.semanticPaneId,
      generation: p.generation,
      incarnation: p.incarnation,
      revision: p.revision,
      stateHash: p.stateHash,
    },
    historyIndex: 1,
  });
  expect(owner.resolve(p, first)).toEqual({ status: "lost" });
  expect(owner.resolve(s, t)).toMatchObject({
    status: "resolved",
    historyIndex: 1,
    proof: { revision: p.revision, stateHash: p.stateHash },
  });
  expect(owner.capture(s, 1).status).toBe("captured");
  expect(owner.capture(s, 0).status).toBe("lost");
  const q = patch(p, { rows: [], historyDelta: { trim: 2, append: [] } });
  owner.observe(q);
  expect(owner.resolve(q, t)).toEqual({ status: "lost" });
});
it.each(["seed", "history", "dimensions", "alternate", "retirement"])(
  "invalidates on %s even when row text is unchanged",
  (kind) => {
    const owner = new HistoryAnchorOwner(),
      s = seed();
    owner.observe(s);
    const t = token(owner, s);
    if (kind === "retirement") {
      owner.invalidate();
      expect(owner.resolve(s, t).status).toBe("unavailable");
      return;
    }
    if (kind === "seed") {
      owner.observe(s);
      expect(owner.resolve(s, t).status).toBe("lost");
      return;
    }
    const p = patch(s, {
      rows: [],
      ...(kind === "history" ? { history: s.snapshot.history } : {}),
      ...(kind === "alternate" ? { modes: { ...blank.modes, alternateScreen: true } } : {}),
    });
    if (kind === "dimensions") p.cols = 5;
    owner.observe(p);
    expect(owner.resolve(p, t).status).toBe(kind === "alternate" ? "unavailable" : "lost");
  },
);
it("bounds tokens, rejects wrong proof and foreign tokens", () => {
  let now = 0;
  const owner = new HistoryAnchorOwner(() => now),
    s = seed();
  owner.observe(s);
  const first = token(owner, s);
  for (let i = 0; i < 32; i++) token(owner, s);
  expect(owner.resolve(s, first).status).toBe("lost");
  const last = token(owner, s);
  expect(owner.resolve({ ...s, incarnation: "replacement" }, last).status).toBe("stale");
  expect(owner.capture({ ...s, semanticPaneId: "other" }, 1).status).toBe("stale");
  const other = new HistoryAnchorOwner();
  other.observe(s);
  expect(other.resolve(s, last).status).toBe("lost");
  now = 300001;
  expect(owner.resolve(s, last).status).toBe("resolved");
  owner.observe(s);
  expect(owner.capture(s, -1).status).toBe("lost");
  expect(owner.capture(s, 4).status).toBe("lost");
});
it("missing or mismatched patch continuity cannot mint anchors", () => {
  const owner = new HistoryAnchorOwner(),
    s = seed();
  const p = patch(s, { rows: [] });
  owner.observe(p);
  expect(owner.capture(p, 0).status).toBe("unavailable");
  owner.observe(s);
  owner.observe({ ...p, baseRevision: 100 });
  expect(owner.capture(p, 0).status).toBe("unavailable");
});

it("evicts old exact proofs and never substitutes latest offsets", () => {
  const owner = new HistoryAnchorOwner();
  const s = seed();
  owner.observe(s);
  let current: CanonicalTerminalReplicaSeed | CanonicalTerminalReplicaPatch = s;
  for (let i = 0; i < 64; i++) {
    current = patch(current, { rows: [] });
    owner.observe(current);
  }
  expect(owner.capture(s, 1).status).toBe("stale");
  expect(owner.capture(current, 1).status).toBe("captured");
});

it("allows a fresh anchor on a quiet current snapshot after historical metadata expires", () => {
  let now = 0;
  const owner = new HistoryAnchorOwner(() => now),
    s = seed();
  owner.observe(s);
  const old = token(owner, s);
  now = 300001;
  expect(owner.resolve(s, old).status).toBe("resolved");
  const fresh = token(owner, s);
  expect(owner.resolve(s, fresh).status).toBe("resolved");
});

it("retains a long-paused anchor while historical capture proofs expire", () => {
  let now = 0;
  const owner = new HistoryAnchorOwner(() => now);
  const s = seed();
  owner.observe(s);
  const saved = token(owner, s, 2);
  now = 24 * 60 * 60_000;
  expect(owner.resolve(s, saved)).toMatchObject({ status: "resolved", historyIndex: 2 });
  expect(owner.capture(s, 1).status).toBe("captured");
  const p = patch(s, { rows: [], historyDelta: { trim: 1, append: [blank.grid[0]!] } });
  owner.observe(p);
  expect(owner.capture(s, 2).status).toBe("stale");
  expect(owner.resolve(p, saved)).toMatchObject({
    status: "resolved",
    historyIndex: 1,
    proof: { revision: p.revision, stateHash: p.stateHash },
  });
  const q = patch(p, { rows: [], historyDelta: { trim: 2, append: [] } });
  owner.observe(q);
  expect(owner.resolve(q, saved)).toEqual({ status: "lost" });
});
