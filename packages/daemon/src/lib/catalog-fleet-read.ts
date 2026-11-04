import type { InteractionPaneEndpoint } from "@tmux-ide/contracts";
import {
  readAdoptedFleet,
  readAdoptedFleetAsync,
  type FleetPaneFacts,
  type FleetSessionFacts,
} from "../command-center/discovery.ts";

/** The two runners a catalog fleet read may use; both are fenced to one tmux server generation. */
export interface CatalogFleetRunners {
  /** The session-mutation fence; only its `active` state is read here. */
  readonly fence: { readonly active: boolean };
  /** Synchronous runner wrapped by that fence: inside a mutation it adds the session check. */
  readonly fencedSync: (args: string[]) => string;
  /** Asynchronous runner fenced to the same server generation. */
  readonly generationFencedAsync: (args: string[]) => Promise<string>;
}

/**
 * Read the catalog fleet without blocking the event loop (#709), except inside
 * a session mutation, where the read keeps the fence's synchronous runner.
 */
export async function readCatalogFleet(
  registry: { list(): { sessionName: string }[] },
  runners: CatalogFleetRunners,
  resolveInteractionEndpoint?: (
    sessionName: string,
    pane: FleetPaneFacts,
  ) => Extract<InteractionPaneEndpoint, { kind: "pane" }> | null,
  nativeServerEpoch?: () => string | null,
): Promise<FleetSessionFacts[] | null> {
  return runners.fence.active
    ? readAdoptedFleet(registry, runners.fencedSync, resolveInteractionEndpoint, nativeServerEpoch)
    : readAdoptedFleetAsync(
        registry,
        runners.generationFencedAsync,
        resolveInteractionEndpoint,
        nativeServerEpoch,
      );
}
