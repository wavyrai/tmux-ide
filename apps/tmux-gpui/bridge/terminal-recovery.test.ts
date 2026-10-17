import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createTerminalRecovery } from "./terminal-recovery.ts";

test("recovery is single-flight and stops after success", async () => {
  let attempts = 0;
  const recovery = createTerminalRecovery({
    delayMs: 1,
    async attempt() {
      await delay(2);
      return ++attempts === 3;
    },
    exhausted() {
      assert.fail("unexpected exhaustion");
    },
  });
  recovery.start();
  recovery.start();
  await delay(50);
  recovery.cancel();
  assert.equal(attempts, 3);
});

test("navigation invalidates an in-flight restoration and prevents further attempts", async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let applied = false,
    attempts = 0;
  const recovery = createTerminalRecovery({
    delayMs: 1,
    async attempt(current) {
      attempts++;
      entered();
      await gate;
      if (current()) applied = true;
      return false;
    },
    exhausted() {
      assert.fail("cancelled recovery exhausted");
    },
  });
  recovery.start();
  await started;
  recovery.cancel();
  release();
  await delay(20);
  assert.equal(applied, false);
  assert.equal(attempts, 1);
});

test("persistent failures stop at the bound instead of reconnect storming", async () => {
  let attempts = 0;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const recovery = createTerminalRecovery({
    delayMs: 1,
    limit: 3,
    async attempt() {
      attempts++;
      throw new Error("private failure");
    },
    exhausted: finish,
  });
  recovery.start();
  await done;
  await delay(10);
  recovery.cancel();
  assert.equal(attempts, 3);
});
