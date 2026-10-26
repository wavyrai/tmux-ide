// Test-only death confirmation after an exact owned-process signal.
import { KernelWitnessReadError } from "../../../scripts/lib/owned-ssh-fixture.mjs";
import { setTimeout } from "node:timers/promises";
export async function waitForOwnedExit(identify, pid, identity, options = {}) {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? setTimeout;
  const deadline = now() + 5000;
  while (now() < deadline) {
    try {
      if ((await identify(pid)) !== identity) return;
    } catch (error) {
      // An exiting process can temporarily refuse the kernel read. This is
      // not proof of death; keep waiting, without signalling again.
      if (!(error instanceof KernelWitnessReadError) || error.status !== 65) throw error;
    }
    await wait(10);
  }
  throw new Error("Owned tunnel exit was not confirmed");
}
