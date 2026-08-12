import { describe, expect, it, vi } from "vitest";

import { ModalAdmissionCoordinator } from "./modal-admission-coordinator.ts";

type ModalKind = "palette" | "dialogs" | "settings";

describe("ModalAdmissionCoordinator", () => {
  it("reserves input through queued, loading, ready, and error states", () => {
    const coordinator = new ModalAdmissionCoordinator<ModalKind>();
    const palette = coordinator.reserve("palette")!;
    expect(coordinator.snapshot()).toEqual({
      phase: "queued",
      generation: 1,
      reserved: true,
      kind: "palette",
    });
    expect(coordinator.markLoading(palette)).toBe(true);
    expect(coordinator.snapshot()).toMatchObject({ phase: "loading", reserved: true });
    expect(coordinator.markReady(palette)).toBe(true);
    expect(coordinator.snapshot()).toMatchObject({ phase: "ready", reserved: true });
    expect(coordinator.markError(palette, new Error("late"))).toBe(false);
    expect(coordinator.release(palette)).toBe(true);
    expect(coordinator.snapshot()).toEqual({
      phase: "idle",
      generation: 2,
      reserved: false,
    });

    const dialogs = coordinator.reserve("dialogs")!;
    expect(coordinator.markError(dialogs, new Error("chunk unavailable"))).toBe(true);
    expect(coordinator.snapshot()).toEqual({
      phase: "error",
      generation: 3,
      reserved: true,
      kind: "dialogs",
      message: "chunk unavailable",
    });
  });

  it("generation-fences every continuation from superseded and released intents", () => {
    const coordinator = new ModalAdmissionCoordinator<ModalKind>();
    const palette = coordinator.reserve("palette")!;
    coordinator.markLoading(palette);
    const settings = coordinator.reserve("settings")!;

    expect(coordinator.isCurrent(palette)).toBe(false);
    expect(coordinator.markReady(palette)).toBe(false);
    expect(coordinator.markError(palette, "stale failure")).toBe(false);
    expect(coordinator.release(palette)).toBe(false);
    expect(coordinator.snapshot()).toMatchObject({
      phase: "queued",
      kind: "settings",
      generation: 2,
    });

    expect(coordinator.markReady(settings)).toBe(true);
    expect(coordinator.release(settings)).toBe(true);
    expect(coordinator.markError(settings, "released failure")).toBe(false);
    expect(coordinator.snapshot()).toMatchObject({ phase: "idle", generation: 3 });
  });

  it("retries only an error with a fresh fenced token", () => {
    const coordinator = new ModalAdmissionCoordinator<ModalKind>();
    expect(coordinator.retry()).toBeNull();
    const original = coordinator.reserve("palette")!;
    coordinator.markError(original, "offline");
    const retry = coordinator.retry()!;
    expect(retry).not.toEqual(original);
    expect(retry).toMatchObject({ kind: "palette", generation: 2 });
    expect(coordinator.snapshot()).toMatchObject({ phase: "queued", generation: 2 });
    expect(coordinator.markReady(original)).toBe(false);
    expect(coordinator.markReady(retry)).toBe(true);
  });

  it("rejects tokens belonging to another application authority", () => {
    const left = new ModalAdmissionCoordinator<ModalKind>();
    const right = new ModalAdmissionCoordinator<ModalKind>();
    const leftToken = left.reserve("dialogs")!;
    right.reserve("dialogs");
    expect(right.isCurrent(leftToken)).toBe(false);
    expect(right.markReady(leftToken)).toBe(false);
    expect(right.release(leftToken)).toBe(false);
  });

  it("publishes each state synchronously without timers and supports explicit release", () => {
    const coordinator = new ModalAdmissionCoordinator<ModalKind>();
    const listener = vi.fn();
    const unsubscribe = coordinator.subscribe(listener);
    const token = coordinator.reserve("palette")!;
    coordinator.markLoading(token);
    coordinator.markError(token, null);
    expect(listener.mock.calls.map(([snapshot]) => snapshot.phase)).toEqual([
      "queued",
      "loading",
      "error",
    ]);
    expect(coordinator.releaseCurrent()).toBe(true);
    expect(coordinator.releaseCurrent()).toBe(false);
    unsubscribe();
    coordinator.reserve("dialogs");
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it("disposal fences active work, clears listeners, and refuses new reservations", () => {
    const coordinator = new ModalAdmissionCoordinator<ModalKind>();
    const listener = vi.fn();
    coordinator.subscribe(listener);
    const token = coordinator.reserve("settings")!;
    coordinator.markLoading(token);
    coordinator.dispose();
    coordinator.dispose();

    expect(coordinator.snapshot()).toEqual({
      phase: "disposed",
      generation: 2,
      reserved: false,
    });
    expect(coordinator.reserve("palette")).toBeNull();
    expect(coordinator.retry()).toBeNull();
    expect(coordinator.markReady(token)).toBe(false);
    expect(coordinator.release(token)).toBe(false);
    expect(coordinator.releaseCurrent()).toBe(false);
    expect(listener.mock.calls.map(([snapshot]) => snapshot.phase)).toEqual([
      "queued",
      "loading",
      "disposed",
    ]);
  });
});
