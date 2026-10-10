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
