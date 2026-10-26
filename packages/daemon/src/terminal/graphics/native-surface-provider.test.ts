import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  NativeSurfaceProviderRegistry,
  type NativeSurfaceProvider,
} from "./native-surface-provider.ts";
const generation = "e01ce8ee-74d8-40d0-9a59-a096050a6ade";
const receiver = () => ({
  type: "terminal-surface-receiver" as const,
  version: 1 as const,
  generation,
  connectionNonce: randomUUID(),
  challenge: randomUUID(),
  pid: 123,
  slot: 0,
  auditToken: [1, 2, 3, 4, 5, 6, 7, 8],
});
const offer = (sequence: number, allocationBytes = 1024) => ({
  type: "terminal-surface-offer",
  version: 1,
  generation,
  pane: "pane.editor",
  incarnation: "pane:1",
  deliveryNonce: randomUUID(),
  canonicalRevision: 1,
  canonicalStateHash: "0000000000000001",
  sequence,
  surfaceId: randomUUID(),
  storageTicket: randomUUID(),
  placement: { row: 0, column: 0, rows: 1, columns: 1 },
  format: "bgra8-straight",
  width: 16,
  height: 16,
  stride: 64,
  allocationBytes,
});
function fixture() {
  const registry = new NativeSurfaceProviderRegistry(generation);
  const clients: Parameters<NativeSurfaceProvider["open"]>[0][] = [];
  const retire = vi.fn(),
    fallback = vi.fn(),
    close = vi.fn(),
    start = vi.fn();
  const unregister = registry.register({
    auditToken: [8, 7, 6, 5, 4, 3, 2, 1],
    open: (context) => {
      clients.push(context);
      return { start, retire, fallback, close };
    },
  });
  const frames: unknown[] = [];
  const session = registry.open(receiver(), ["pane.editor"], (frame) => {
    frames.push(frame);
    return true;
  })!;
  return { registry, clients, session, frames, retire, fallback, close, unregister };
}
describe("native producer registration", () => {
  it("closes an owner returned after synchronous registration shutdown", () => {
    const registry = new NativeSurfaceProviderRegistry(generation);
    const close = vi.fn(),
      start = vi.fn();
    registry.register({
      auditToken: [1, 2, 3, 4, 5, 6, 7, 8],
      open: () => {
        registry.close();
        return { start, close, retire() {}, fallback() {} };
      },
    });
    registry.open(receiver(), ["pane.editor"], () => true);
    expect(start).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
  it.each(["terminal-surface-peer", "terminal-surface-offer"])(
    "revokes transfer authorization when unregistering during %s delivery",
    (trigger) => {
      const registry = new NativeSurfaceProviderRegistry(generation);
      let context: Parameters<NativeSurfaceProvider["open"]>[0] | undefined;
      const start = vi.fn(),
        fallback = vi.fn(),
        close = vi.fn();
      const unregister = registry.register({
        auditToken: [1, 2, 3, 4, 5, 6, 7, 8],
        open: (value) => {
          context = value;
          return { start, fallback, close, retire() {} };
        },
      });
      registry.open(receiver(), ["pane.editor"], (frame) => {
        if (frame.type === trigger) unregister();
        return true;
      });
      if (trigger === "terminal-surface-peer") expect(start).not.toHaveBeenCalled();
      else expect(start).toHaveBeenCalledOnce();
      expect(context!.offer(offer(1))).toBe(false);
      expect(context!.offer(offer(2))).toBe(false);
      expect(fallback).toHaveBeenCalledOnce();
      registry.close();
      expect(close).toHaveBeenCalledOnce();
    },
  );
  it("binds the viewer nonce without changing canonical identity and rejects a retired target", () => {
    const registry = new NativeSurfaceProviderRegistry(generation);
    let context: Parameters<NativeSurfaceProvider["open"]>[0] | undefined;
    registry.register({
      auditToken: [1, 2, 3, 4, 5, 6, 7, 8],
      open: (value) => {
        context = value;
        return { start() {}, retire() {}, fallback() {}, close() {} };
      },
    });
    const frames: unknown[] = [];
    const targetNonce = randomUUID();
    let current = true;
    registry.open(
      receiver(),
      ["pane.editor"],
      (value) => {
        frames.push(value);
        return true;
      },
      (pane, ownerGeneration) =>
        current && pane === "pane.editor" && ownerGeneration === generation ? targetNonce : null,
    );
    const source = offer(1);
    expect(context!.offer(source)).toBe(true);
    expect(frames[1]).toEqual({ ...source, deliveryNonce: targetNonce });
    expect(source.deliveryNonce).not.toBe(targetNonce);
    current = false;
    expect(context!.offer(offer(2))).toBe(false);
    expect(frames).toHaveLength(2);
    registry.close();
  });
  it("scopes offers and retirement to one connection and enforces its window", () => {
    const f = fixture();
    expect(f.frames[0]).toMatchObject({
      type: "terminal-surface-peer",
      auditToken: [8, 7, 6, 5, 4, 3, 2, 1],
    });
    expect(f.clients[0]!.offer({ ...offer(1), pane: "pane.other" })).toBe(false);
    expect(f.clients[0]!.offer({ ...offer(1), generation: randomUUID() })).toBe(false);
    for (let i = 1; i <= 8; i++) expect(f.clients[0]!.offer(offer(i))).toBe(true);
    expect(f.clients[0]!.offer(offer(9))).toBe(false);
    expect(f.session.retire(99)).toBe(false);
    expect(f.session.retire(1)).toBe(true);
    expect(f.session.retire(1)).toBe(false);
    expect(f.clients[0]!.offer(offer(8))).toBe(false);
    expect(f.clients[0]!.offer(offer(9))).toBe(true);
    expect(f.retire).toHaveBeenCalledExactlyOnceWith(1);
    f.registry.close();
    expect(f.clients[0]!.offer(offer(10))).toBe(false);
    expect(f.session.retire(2)).toBe(false);
    expect(f.close).toHaveBeenCalledOnce();
  });
  it("retains old GPU acknowledgments through fallback and provider replacement", () => {
    const f = fixture();
    expect(f.clients[0]!.offer(offer(1))).toBe(true);
    f.unregister();
    f.unregister();
    expect(f.fallback).toHaveBeenCalledOnce();
    expect(f.clients[0]!.offer(offer(2))).toBe(false);
    const nextRetire = vi.fn();
    f.registry.register({
      auditToken: [1, 1, 1, 1, 1, 1, 1, 1],
      open: () => ({ start() {}, retire: nextRetire, fallback() {}, close() {} }),
    });
    f.unregister();
    expect(f.registry.available).toBe(true);
    expect(f.session.retire(1)).toBe(true);
    expect(f.retire).toHaveBeenCalledExactlyOnceWith(1);
    expect(nextRetire).not.toHaveBeenCalled();
    f.registry.close();
  });
  it("charges padded allocation against process and connection bounds", () => {
    const f = fixture();
    for (let i = 1; i < 5; i++) f.registry.open(receiver(), ["pane.editor"], () => true);
    for (let i = 0; i < 4; i++) expect(f.clients[i]!.offer(offer(1, 64 * 1024 * 1024))).toBe(true);
    expect(f.clients[0]!.offer(offer(2))).toBe(false);
    expect(f.clients[4]!.offer(offer(1))).toBe(false);
    f.session.close();
    expect(f.clients[4]!.offer(offer(1))).toBe(true);
    f.registry.close();
  });
  it("does not start a provider on another generation or a failed control sink", () => {
    const f = fixture();
    expect(
      f.registry.open({ ...receiver(), generation: randomUUID() }, ["pane.editor"], () => true),
    ).toBeNull();
    const session = f.registry.open(receiver(), ["pane.editor"], () => false)!;
    expect(session.retire(1)).toBe(false);
    expect(f.close).toHaveBeenCalledOnce();
    f.registry.close();
  });
});
