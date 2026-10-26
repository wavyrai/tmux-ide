import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { TerminalSurfaceAvailable, TerminalSurfaceReceiver } from "@tmux-ide/contracts";
import {
  NativeSurfaceProviderRegistry,
  type NativeSurfaceProvider,
} from "./native-surface-provider.ts";
import { NativeSurfaceViewer } from "./native-surface-viewer.ts";
const generation = randomUUID();
const flush = () => Promise.resolve();
function setup() {
  const registry = new NativeSurfaceProviderRegistry(generation);
  const frames: Parameters<ConstructorParameters<typeof NativeSurfaceViewer>[2]>[0][] = [];
  const viewer = new NativeSurfaceViewer(
    registry,
    ["pane.browser"],
    (frame) => {
      frames.push(frame);
      return true;
    },
    () => randomUUID(),
  );
  viewer.start();
  const nonce = () =>
    (
      frames
        .filter((f) => f.type === "terminal-surface-available")
        .at(-1) as TerminalSurfaceAvailable
    ).connectionNonce!;
  const receiver = (): TerminalSurfaceReceiver => ({
    type: "terminal-surface-receiver",
    version: 1,
    generation,
    connectionNonce: nonce(),
    challenge: randomUUID(),
    pid: 123,
    slot: 0,
    auditToken: [1, 2, 3, 4, 5, 6, 7, 8],
  });
  const register = () => {
    let context: Parameters<NativeSurfaceProvider["open"]>[0];
    const retire = vi.fn(),
      close = vi.fn();
    const unregister = registry.register({
      auditToken: [8, 7, 6, 5, 4, 3, 2, 1],
      open: (ctx) => {
        context = ctx;
        return { start() {}, fallback() {}, retire, close };
      },
    });
    const offer = () =>
      context.offer({
        type: "terminal-surface-offer",
        version: 1,
        generation,
        pane: "pane.browser",
        incarnation: "pane:1",
        deliveryNonce: randomUUID(),
        canonicalRevision: 1,
        canonicalStateHash: "0000000000000001",
        sequence: 1,
        surfaceId: randomUUID(),
        storageTicket: randomUUID(),
        placement: { row: 0, column: 0, rows: 1, columns: 1 },
        format: "bgra8-straight",
        width: 16,
        height: 16,
        stride: 64,
        allocationBytes: 1024,
      });
    return { unregister, retire, close, offer };
  };
  return { registry, viewer, frames, nonce, receiver, register };
}
describe("native viewer on an existing terminal socket", () => {
  it("falls back without throwing when availability subscriptions are exhausted", () => {
    const registry = new NativeSurfaceProviderRegistry(generation);
    for (let i = 0; i < 256; i++) registry.watchAvailability(() => {});
    const send = vi.fn(() => true);
    const viewer = new NativeSurfaceViewer(registry, ["pane.browser"], send, () => null);
    expect(() => viewer.start()).not.toThrow();
    expect(send).toHaveBeenCalledExactlyOnceWith({
      type: "terminal-surface-available",
      version: 1,
      generation,
      connectionNonce: null,
    });
    viewer.close();
    registry.close();
  });

  it("waits without a provider and keeps old retirement separate across replacement", async () => {
    const f = setup();
    await flush();
    expect(f.nonce()).toBeNull();
    const first = f.register();
    await flush();
    const old = f.receiver();
    expect(f.viewer.receive(old)).toBe(true);
    expect(first.offer()).toBe(true);
    first.unregister();
    const second = f.register();
    await flush();
    const current = f.receiver();
    expect(current.connectionNonce).not.toBe(old.connectionNonce);
    expect(f.viewer.receive(current)).toBe(true);
    expect(second.offer()).toBe(true);
    expect(f.viewer.receive(old)).toBe(false);
    expect(
      f.viewer.retire({
        type: "terminal-surface-retired",
        version: 1,
        generation,
        connectionNonce: old.connectionNonce,
        sequence: 1,
      }),
    ).toBe(true);
    expect(first.retire).toHaveBeenCalledExactlyOnceWith(1);
    expect(second.retire).not.toHaveBeenCalled();
    expect(first.close).toHaveBeenCalledOnce();
    expect(
      f.viewer.retire({
        type: "terminal-surface-retired",
        version: 1,
        generation,
        connectionNonce: old.connectionNonce,
        sequence: 1,
      }),
    ).toBe(false);
    f.viewer.close();
    f.registry.close();
  });
  it("cannot resurrect a used negotiation after fallback and ignores duplicate watches", async () => {
    const f = setup();
    f.register();
    await flush();
    const receiver = f.receiver();
    expect(f.viewer.receive(receiver)).toBe(true);
    f.viewer.start();
    await flush();
    expect(f.nonce()).toBe(receiver.connectionNonce);
    expect(
      f.viewer.fallback({
        type: "terminal-surface-fallback",
        version: 1,
        generation,
        connectionNonce: receiver.connectionNonce,
        reason: "storage",
      }),
    ).toBe(true);
    expect(f.viewer.receive(receiver)).toBe(false);
    f.viewer.close();
    f.registry.close();
  });
  it("bounds retained provider generations without freeing unacknowledged storage", async () => {
    const f = setup();
    const providers = [];
    for (let i = 0; i < 9; i++) {
      const provider = f.register();
      providers.push(provider);
      await flush();
      expect(f.viewer.receive(f.receiver())).toBe(true);
      if (i < 8) expect(provider.offer()).toBe(true);
      provider.unregister();
    }
    expect(f.frames).toContainEqual(
      expect.objectContaining({ type: "terminal-surface-fallback", reason: "budget" }),
    );
    expect(providers.slice(0, 8).every((p) => p.close.mock.calls.length === 0)).toBe(true);
    f.viewer.close();
    expect(providers.slice(0, 8).every((p) => p.close.mock.calls.length === 1)).toBe(true);
    f.registry.close();
  });
});
