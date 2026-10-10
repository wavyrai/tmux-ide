import { NativeJournalCapabilitySchemaZ } from "@tmux-ide/contracts";
import type { OwnerInteractionObservation } from "./owner-interaction-observation.ts";
import {
  supportsNativeSplitResize,
  type NativeSplitRunner,
} from "../terminal/protocol/native-split-resize.ts";

/** Read-only issuance gate, not mutation authorization. No cache survives a
 * probe: the selected pinned server must report the captured native epoch on
 * both sides of the exact split capability reply. Runners bound time/output. */
export function createNativeSplitCapabilityProbe(options: {
  observation: () => Pick<
    OwnerInteractionObservation,
    | "nativeServerEpoch"
    | "ownedOperationTransport"
    | "ownedOperationEpochGuard"
    | "ownedOperationPaneGuard"
    | "ownedOperationSessionGuard"
  > | null;
  runPinnedTmux: NativeSplitRunner;
}): (epoch: string) => Promise<boolean> {
  return async (epoch) => {
    const observation = options.observation();
    const current = () =>
      observation !== null &&
      options.observation() === observation &&
      observation.nativeServerEpoch === epoch &&
      observation.ownedOperationTransport &&
      observation.ownedOperationEpochGuard &&
      observation.ownedOperationPaneGuard &&
      observation.ownedOperationSessionGuard;
    const sameNativeEpoch = async () => {
      const text = await options.runPinnedTmux(["tmux-ide-events", "-V"]);
      if (typeof text !== "string" || Buffer.byteLength(text) > 16384) return false;
      const value = NativeJournalCapabilitySchemaZ.parse(JSON.parse(text));
      return (
        value.serverEpoch === epoch &&
        value.enabled &&
        value.degraded === 0 &&
        value.ownedOperationTransport === "direct-wrapper-v1" &&
        value.ownedOperationEpochGuard === "server-epoch-v1" &&
        value.ownedOperationPaneGuard === "direct-pane-v1" &&
        value.ownedOperationSessionGuard === "direct-session-v1"
      );
    };
    try {
      if (!current() || !(await sameNativeEpoch()) || !current()) return false;
      if (!(await supportsNativeSplitResize(options.runPinnedTmux)) || !current()) return false;
      return (await sameNativeEpoch()) && current();
    } catch {
      return false;
    }
  };
}

/** Only an explicit canonical split read activates an otherwise stock owner.
 * Preflight is read-only; unsupported binaries never reach the enabling reader. */
export function createNativeSplitReadiness(options: {
  observation: () => OwnerInteractionObservation | null;
  runPinnedTmux: NativeSplitRunner;
}): () => Promise<boolean> {
  let pending: Promise<boolean> | null = null;
  const prepare = async () => {
    const observation = options.observation();
    if (!observation) return false;
    if (
      observation.nativeServerEpoch &&
      observation.ownedOperationSessionGuard &&
      observation.ownedOperationPaneGuard
    )
      return true;
    const probe = async () => {
      const text = await options.runPinnedTmux(["tmux-ide-events", "-V"]);
      if (typeof text !== "string" || Buffer.byteLength(text) > 16384)
        throw new Error("Invalid capability");
      const value = NativeJournalCapabilitySchemaZ.parse(JSON.parse(text));
      if (
        value.degraded !== 0 ||
        value.ownedOperationTransport !== "direct-wrapper-v1" ||
        value.ownedOperationEpochGuard !== "server-epoch-v1" ||
        value.ownedOperationPaneGuard !== "direct-pane-v1" ||
        value.ownedOperationSessionGuard !== "direct-session-v1"
      )
        throw new Error("Unsupported capability");
      return value.serverEpoch;
    };
    try {
      const epoch = await probe();
      if (
        options.observation() !== observation ||
        !(await supportsNativeSplitResize(options.runPinnedTmux))
      )
        return false;
      if ((await probe()) !== epoch || options.observation() !== observation) return false;
      return (await observation.activateForSplit(epoch)) && options.observation() === observation;
    } catch {
      return false;
    }
  };
  return () =>
    (pending ??= prepare().finally(() => {
      pending = null;
    }));
}
