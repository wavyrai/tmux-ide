import { expect, it, vi } from "vitest";
import { RegisteredWindowGuard } from "./registered-window-guard.ts";

it("shares a proof and performs no additional reads until invalidation", async () => {
  const reader = vi.fn(async () => [
    { session: "a", window: "@1" },
    { session: "a", window: "@1" },
    { session: "b", window: "@2" },
  ]);
  const guard = new RegisteredWindowGuard(reader);
  expect(guard.blocked("a")).toBe(true);
  await Promise.all([guard.verify(), guard.verify()]);
  for (let i = 0; i < 20; i++) await guard.verify();
  expect(reader).toHaveBeenCalledTimes(1);
  expect(guard.blocked("a")).toBe(false);
  guard.invalidate();
  reader.mockResolvedValue([
    { session: "a", window: "@1" },
    { session: "b", window: "@1" },
  ]);
  await guard.verify();
  expect(reader).toHaveBeenCalledTimes(2);
  expect(guard.blocked("a")).toBe(true);
  expect(guard.blocked("b")).toBe(true);
  expect(guard.blocked("independent")).toBe(false);
});

it("cannot revive a superseded proof even if its reader ignores cancellation", async () => {
  let finish!: (rows: { session: string; window: string }[]) => void;
  const reader = vi.fn(
    () =>
      new Promise<{ session: string; window: string }[]>((resolve) => {
        finish = resolve;
      }),
  );
  const guard = new RegisteredWindowGuard(reader);
  const old = guard.verify();
  const rejected = expect(old).rejects.toThrow();
  await Promise.resolve();
  guard.invalidate();
  finish([]);
  await rejected;
  expect(guard.blocked("a")).toBe(true);
});

it("keeps failed discovery blocked and allows an explicit retry", async () => {
  const reader = vi.fn().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue([]);
  const guard = new RegisteredWindowGuard(reader);
  await expect(guard.verify()).rejects.toThrow("unavailable");
  expect(guard.blocked("a")).toBe(true);
  await guard.verify();
  expect(guard.blocked("a")).toBe(false);
});

it("does not start new inventory reads after disposal", async () => {
  const reader = vi.fn(async () => []);
  const guard = new RegisteredWindowGuard(reader);
  const pending = guard.verify();
  const rejected = expect(pending).rejects.toThrow();
  guard.dispose();
  await rejected;
  await expect(guard.verify()).rejects.toThrow("disposed");
  expect(reader).not.toHaveBeenCalled();
  expect(guard.blocked("a")).toBe(true);
});
