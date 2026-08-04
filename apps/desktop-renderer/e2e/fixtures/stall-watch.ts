/**
 * Tells "the app is broken" apart from "this machine stopped running us".
 *
 * Every wait in this suite is a wall-clock deadline, which silently assumes the
 * harness process is being scheduled. When the host freezes — a Time Machine
 * snapshot, a swap storm, an overloaded CI box — the deadline expires without
 * the harness executing a single instruction, and the failure that surfaces is
 * whatever assertion happened to be pending. That failure names a product bug
 * which does not exist, and someone then spends an afternoon chasing it.
 *
 * This was not hypothetical: an intermittent, alternating-victim failure in
 * this suite was tracked to the host descheduling EVERY process for minutes at
 * a time. The proof was that an unrelated `sh` loop sleeping in half-second
 * ticks recorded the same 282-second gap, to the second, as the test worker.
 *
 * The discriminator is CPU time. A worker blocked in its own code burns CPU; a
 * worker that is not being scheduled burns none. Sampling both, a stall with
 * near-zero CPU consumption is provably not the product's fault, and the suite
 * says so in the failure instead of blaming the app.
 */
import type { TestInfo } from "@playwright/test";

/** A wall-clock gap this long with no CPU is not normal scheduling jitter. */
const STALL_THRESHOLD_MS = 5_000;
/** Above this share of the gap spent on CPU, the process was working, not starved. */
const BUSY_CPU_RATIO = 0.5;
const SAMPLE_INTERVAL_MS = 250;

export interface HarnessStall {
  readonly wallGapMs: number;
  readonly cpuMs: number;
}

export interface StallWatch {
  readonly stalls: readonly HarnessStall[];
  readonly stop: () => void;
}

export function watchForHarnessStalls(): StallWatch {
  const stalls: HarnessStall[] = [];
  let lastAt = Date.now();
  let lastCpu = process.cpuUsage();

  const timer = setInterval(() => {
    const now = Date.now();
    const cpu = process.cpuUsage();
    const wallGapMs = now - lastAt - SAMPLE_INTERVAL_MS;
    const cpuMs = (cpu.user - lastCpu.user + (cpu.system - lastCpu.system)) / 1_000;
    lastAt = now;
    lastCpu = cpu;
    if (wallGapMs < STALL_THRESHOLD_MS) return;
    // Burning CPU through the gap means our own code blocked the loop, which IS
    // this suite's bug to fix. Only a starved process is excused.
    if (cpuMs > wallGapMs * BUSY_CPU_RATIO) return;
    stalls.push({ wallGapMs, cpuMs });
  }, SAMPLE_INTERVAL_MS);
  // Never hold the worker open on this timer's account.
  timer.unref();

  return { stalls, stop: () => clearInterval(timer) };
}

/**
 * Annotate a failure that happened while the harness was not running.
 *
 * Deliberately an annotation and not a skip: the run still goes red, because a
 * suite that quietly excuses its own failures is worse than a flaky one. What
 * changes is that the reason is stated where the failure is read.
 */
export function reportHarnessStalls(testInfo: TestInfo, watch: StallWatch): void {
  watch.stop();
  if (watch.stalls.length === 0) return;

  const total = watch.stalls.reduce((sum, stall) => sum + stall.wallGapMs, 0);
  const worst = Math.max(...watch.stalls.map((stall) => stall.wallGapMs));
  const description =
    `The test process was descheduled by the host for ${(total / 1_000).toFixed(1)}s across ` +
    `${watch.stalls.length} stall(s) (longest ${(worst / 1_000).toFixed(1)}s), consuming almost no ` +
    `CPU throughout. Wall-clock deadlines in this run expired without the harness executing. ` +
    `If this test failed on a timeout, suspect the host — a backup, an indexer, memory pressure, ` +
    `or an oversubscribed CI box — before suspecting the app.`;

  testInfo.annotations.push({ type: "harness-stall", description });
  if (testInfo.status !== testInfo.expectedStatus) {
    console.log(`\n[harness-stall] ${description}\n`);
  }
}
