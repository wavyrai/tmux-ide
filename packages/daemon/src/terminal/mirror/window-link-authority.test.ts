import { describe, expect, it } from "vitest";
import { WINDOW_LINK_MAX_LINKS, type WindowLinkTopology } from "@tmux-ide/contracts";
import { WindowLinkAuthority, type NativeWindowLinkObservation } from "./window-link-authority.ts";

const session = `live-session.${"a".repeat(20)}`;
const otherSession = `live-session.${"b".repeat(20)}`;
const first: NativeWindowLinkObservation = {
  index: 0,
  runtimeWindowId: "@0",
  semanticWindowId: "window.first",
  active: true,
};
const linked = { ...first, index: 3, active: false };
const second = {
  index: 8,
  runtimeWindowId: "@1",
  semanticWindowId: "window.second",
  active: false,
};
function target(snapshot: WindowLinkTopology, index = 0) {
  const link = snapshot.links.find((row) => row.displayIndex === index)!;
  return {
    liveSessionId: snapshot.liveSessionId,
    linkId: link.linkId,
    expectedSemanticWindowId: link.semanticWindowId,
    linkRevision: snapshot.linkRevision,
  };
}

describe("window link observation authority", () => {
  it("distinguishes duplicate links and updates active link without retiring backing authority", () => {
    const authority = new WindowLinkAuthority(session, "$0");
    const before = authority.reconcile([first, linked, second]);
    expect(before.links[0]!.semanticWindowId).toBe(before.links[1]!.semanticWindowId);
    expect(before.links[0]!.linkId).not.toBe(before.links[1]!.linkId);
    expect(authority.resolve(target(before, 3))).toEqual({
      runtimeSessionId: "$0",
      runtimeWindowId: "@0",
      index: 3,
    });
    const selected = authority.reconcile([
      { ...linked, active: true },
      second,
      { ...first, active: false },
    ]);
    expect(selected.linkRevision).toBe(before.linkRevision);
    expect(selected.links).toEqual(before.links);
    expect(selected.activeLinkId).toBe(before.links[1]!.linkId);
    expect(authority.resolve(target(before))).toMatchObject({ index: 0 });
    expect(() => authority.uniqueTargetForBacking(first.semanticWindowId)).toThrow(
      "window_link_ambiguous",
    );
    expect(authority.uniqueTargetForBacking(second.semanticWindowId)).toEqual(target(selected, 8));
  });

  it("retires reindexed/swapped observations and rejects stale targets even for surviving handles", () => {
    const authority = new WindowLinkAuthority(session, "$0");
    const before = authority.reconcile([first, linked, second]);
    const swapped = authority.reconcile([
      { ...second, index: 0, active: true },
      linked,
      { ...first, index: 8, active: false },
    ]);
    expect(swapped.linkRevision).toBeGreaterThan(before.linkRevision);
    expect(swapped.links[1]!.linkId).toBe(before.links[1]!.linkId);
    expect(swapped.links[0]!.linkId).not.toBe(before.links[0]!.linkId);
    expect(() => authority.resolve(target(before, 3))).toThrow("window_link_stale");
    expect(() =>
      authority.resolve({ ...target(before), linkRevision: swapped.linkRevision }),
    ).toThrow("window_link_stale");
    expect(authority.resolve(target(swapped))).toMatchObject({ runtimeWindowId: "@1" });
    const renumbered = authority.reconcile([
      { ...second, index: 0, active: true },
      { ...linked, index: 1 },
    ]);
    expect(renumbered.links[1]!.linkId).not.toBe(swapped.links[1]!.linkId);
    expect(authority.uniqueTargetForBacking(first.semanticWindowId)).toEqual(target(renumbered, 1));
  });

  it("retires handles when native backing or its verified semantic stamp changes", () => {
    const authority = new WindowLinkAuthority(session, "$0");
    const before = authority.reconcile([first]);
    const replacement = authority.reconcile([{ ...first, runtimeWindowId: "@9" }]);
    expect(replacement.links[0]!.linkId).not.toBe(before.links[0]!.linkId);
    const restamped = authority.reconcile([
      { ...first, runtimeWindowId: "@9", semanticWindowId: "window.restamped" },
    ]);
    expect(restamped.links[0]!.linkId).not.toBe(replacement.links[0]!.linkId);
    expect(() => authority.resolve(target(before))).toThrow("window_link_stale");
  });

  it("fences session mismatch, backing mismatch and a different authority generation", () => {
    const owner = new WindowLinkAuthority(session, "$0");
    const snapshot = owner.reconcile([first]);
    const requested = target(snapshot);
    expect(() => owner.resolve({ ...requested, liveSessionId: otherSession })).toThrow(
      "window_link_session_mismatch",
    );
    expect(() => owner.resolve({ ...requested, expectedSemanticWindowId: "window.other" })).toThrow(
      "window_link_backing_mismatch",
    );
    const newOwner = new WindowLinkAuthority(session, "$0");
    newOwner.reconcile([first]);
    expect(() => newOwner.resolve(requested)).toThrow("window_link_stale");
  });

  it("revokes authority immediately after uncertain continuity and cannot resurrect it after dispose", () => {
    const authority = new WindowLinkAuthority(session, "$0");
    const before = authority.reconcile([first, linked]);
    authority.invalidate();
    expect(authority.snapshot()).toBeNull();
    expect(() => authority.resolve(target(before))).toThrow("window_link_stale");
    const after = authority.reconcile([first, linked]);
    expect(after.links.every((row) => before.links.every((old) => old.linkId !== row.linkId))).toBe(
      true,
    );
    expect(after.linkRevision).toBeGreaterThan(before.linkRevision);
    authority.dispose();
    expect(() => authority.reconcile([first])).toThrow("window_link_stale");
    expect(() => authority.resolve(target(after))).toThrow("window_link_stale");
  });

  it.each([
    [],
    [first, first],
    [{ ...first, active: false }],
    [first, { ...linked, active: true }],
    [first, { ...linked, semanticWindowId: "window.inconsistent" }],
    [first, { ...second, semanticWindowId: first.semanticWindowId }],
    [{ ...first, index: -1 }],
    [{ ...first, index: Number.MAX_SAFE_INTEGER + 1 }],
    [{ ...first, runtimeWindowId: "@0; kill-server" }],
    [{ ...first, semanticWindowId: "@0" }],
    Array.from({ length: WINDOW_LINK_MAX_LINKS + 1 }, (_, index) => ({
      ...first,
      index,
      active: index === 0,
    })),
  ])("rejects malformed topology atomically (%#)", (...rows) => {
    const authority = new WindowLinkAuthority(session, "$0");
    const before = authority.reconcile([first]);
    expect(() => authority.reconcile(rows)).toThrow();
    expect(authority.snapshot()).toBeNull();
    expect(() => authority.resolve(target(before))).toThrow("window_link_stale");
    const recovered = authority.reconcile([first]);
    expect(recovered.links[0]!.linkId).not.toBe(before.links[0]!.linkId);
  });

  it("does not allow a consumer or caller to mutate the authoritative snapshot", () => {
    const authority = new WindowLinkAuthority(session, "$0");
    const input = { ...first };
    const snapshot = authority.reconcile([input]);
    const originalTarget = target(snapshot);
    input.index = 77;
    snapshot.links[0]!.displayIndex = 88;
    snapshot.links.length = 0;
    expect(authority.resolve(originalTarget)).toMatchObject({ index: 0 });
    expect(authority.snapshot()!.links).toHaveLength(1);
  });
});
