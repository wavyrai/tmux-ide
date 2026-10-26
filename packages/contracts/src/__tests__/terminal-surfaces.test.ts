import { PaneStreamClientFrameSchemaZ, PaneStreamServerFrameSchemaZ } from "../pane-stream.ts";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  TerminalSurfaceOfferSchemaZ,
  TerminalSurfaceReceiverSchemaZ,
  TerminalSurfacePeerSchemaZ,
  TerminalSurfaceRetiredSchemaZ,
  TerminalSurfaceFallbackSchemaZ,
} from "../terminal-surfaces.ts";
const id = "24f1f27b-796d-4f64-a20f-91d355b82dc5";
const nil = "00000000-0000-0000-0000-000000000000";
const scope = { version: 1, generation: id, connectionNonce: id };
const receiver = {
  type: "terminal-surface-receiver",
  ...scope,
  pid: 123,
  slot: 0,
  auditToken: [1, 2, 3, 4, 5, 123, 7, 8],
  challenge: id,
};
const offer = {
  type: "terminal-surface-offer",
  version: 1,
  pane: "pane.native",
  generation: id,
  incarnation: "pane-incarnation",
  deliveryNonce: id,
  canonicalRevision: 7,
  canonicalStateHash: "0123456789abcdef",
  sequence: 1,
  surfaceId: id,
  placement: { row: 0, column: 0, rows: 1, columns: 1 },
  storageTicket: id,
  format: "bgra8-straight",
  width: 16,
  height: 16,
  stride: 256,
  allocationBytes: 16384,
};

describe("native surface control bounds", () => {
  it("accepts padded backing allocations and full audit identities", () => {
    expect(TerminalSurfaceOfferSchemaZ.parse(offer)).toEqual(offer);
    expect(TerminalSurfaceReceiverSchemaZ.parse(receiver)).toEqual(receiver);
    expect(
      TerminalSurfacePeerSchemaZ.safeParse({
        type: "terminal-surface-peer",
        ...scope,
        auditToken: receiver.auditToken,
      }).success,
    ).toBe(true);
  });
  it.each([
    { pid: 0 },
    { pid: 0x80000000 },
    { slot: 32 },
    { slot: -1 },
    { auditToken: Array(8).fill(0) },
    { auditToken: [1] },
    { auditToken: Array(8).fill(0x100000000) },
    { connectionNonce: nil },
    { challenge: nil },
    { path: "/tmp/pixels" },
    { port: 123 },
  ])("rejects unsafe endpoint descriptor %j", (change) => {
    expect(TerminalSurfaceReceiverSchemaZ.safeParse({ ...receiver, ...change }).success).toBe(
      false,
    );
  });
  it.each([
    { width: 0 },
    { height: 16385 },
    { stride: 63 },
    { stride: 68, allocationBytes: 1024 },
    { allocationBytes: 64 * 1024 * 1024 + 1 },
    { sequence: 0 },
    { sequence: Number.MAX_SAFE_INTEGER + 1 },
    { surfaceId: nil },
    { storageTicket: nil },
    { canonicalStateHash: "bad" },
    { format: "rgba8" },
    { storagePath: "/tmp/pixels" },
  ])("rejects invalid offer %j", (change) => {
    expect(TerminalSurfaceOfferSchemaZ.safeParse({ ...offer, ...change }).success).toBe(false);
  });
  it("requires a native negotiation identity for retirement", () => {
    const ack = { type: "terminal-surface-retired", ...scope, sequence: 1 };
    for (const field of ["generation", "connectionNonce"] as const) {
      const missing: Record<string, unknown> = { ...ack };
      delete missing[field];
      expect(TerminalSurfaceRetiredSchemaZ.safeParse(missing).success).toBe(false);
      expect(TerminalSurfaceRetiredSchemaZ.safeParse({ ...ack, [field]: "invalid" }).success).toBe(
        false,
      );
    }
  });
  it("does not confuse retirement with reception or arbitrary diagnostics", () => {
    expect(
      TerminalSurfaceRetiredSchemaZ.safeParse({
        type: "terminal-surface-retired",
        ...scope,
        sequence: 1,
      }).success,
    ).toBe(true);
    expect(
      TerminalSurfaceRetiredSchemaZ.safeParse({
        type: "terminal-surface-received",
        version: 1,
        sequence: 1,
      }).success,
    ).toBe(false);
    expect(
      TerminalSurfaceFallbackSchemaZ.safeParse({
        type: "terminal-surface-fallback",
        ...scope,
        reason: "timeout",
      }).success,
    ).toBe(true);
    expect(
      TerminalSurfaceFallbackSchemaZ.safeParse({
        type: "terminal-surface-fallback",
        ...scope,
        reason: "secret diagnostic",
      }).success,
    ).toBe(false);
  });
});

it("agrees with Rust native admission on shared wire vectors", () => {
  const vectors = JSON.parse(
    readFileSync(
      new URL("../../../../apps/tmux-gpui/fixtures/native-surface-offers.json", import.meta.url),
      "utf8",
    ),
  ) as {
    cases: Array<{ name: string; valid: boolean; offer: unknown }>;
  };
  for (const item of vectors.cases)
    expect(TerminalSurfaceOfferSchemaZ.safeParse(item.offer).success, item.name).toBe(item.valid);
});

describe("native surface stream directions", () => {
  it("keeps availability announcements downstream and subscriptions upstream", () => {
    const watch = { type: "terminal-surface-watch", version: 1, generation: id };
    const available = { type: "terminal-surface-available", ...scope };
    expect(PaneStreamServerFrameSchemaZ.safeParse(watch).success).toBe(false);
    expect(PaneStreamClientFrameSchemaZ.safeParse(available).success).toBe(false);
    expect(
      PaneStreamServerFrameSchemaZ.safeParse({ ...available, connectionNonce: nil }).success,
    ).toBe(false);
    expect(
      PaneStreamClientFrameSchemaZ.safeParse({ ...watch, generation: "invalid" }).success,
    ).toBe(false);
  });

  it("admits only client negotiation, retirement and fallback upstream", () => {
    for (const frame of [
      receiver,
      { type: "terminal-surface-watch", version: 1, generation: id },
      { type: "terminal-surface-retired", ...scope, sequence: 1 },
      { type: "terminal-surface-fallback", ...scope, reason: "unsupported" },
    ]) {
      expect(PaneStreamClientFrameSchemaZ.safeParse(frame).success).toBe(true);
    }
    expect(PaneStreamClientFrameSchemaZ.safeParse(offer).success).toBe(false);
    expect(
      PaneStreamClientFrameSchemaZ.safeParse({
        type: "terminal-surface-peer",
        ...scope,
        auditToken: receiver.auditToken,
      }).success,
    ).toBe(false);
  });
  it("admits only provider peer, offers and fallback downstream", () => {
    for (const frame of [
      offer,
      { type: "terminal-surface-available", ...scope },
      { type: "terminal-surface-available", ...scope, connectionNonce: null },
      { type: "terminal-surface-peer", ...scope, auditToken: receiver.auditToken },
      { type: "terminal-surface-fallback", ...scope, reason: "unsupported" },
    ]) {
      expect(PaneStreamServerFrameSchemaZ.safeParse(frame).success).toBe(true);
    }
    expect(PaneStreamServerFrameSchemaZ.safeParse(receiver).success).toBe(false);
    expect(
      PaneStreamServerFrameSchemaZ.safeParse({
        type: "terminal-surface-retired",
        ...scope,
        sequence: 1,
      }).success,
    ).toBe(false);
  });
});
