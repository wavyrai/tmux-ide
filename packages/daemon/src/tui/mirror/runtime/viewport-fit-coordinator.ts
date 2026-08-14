import {
  FirstLatestCoordinator,
  type FirstLatestRequest,
} from "@tmux-ide/daemon-client/first-latest-coordinator";

export type ViewportFitRequest = FirstLatestRequest;

/**
 * OpenTUI compatibility name for the shared first+latest coordinator. Local
 * Yoga preview remains renderer-owned; only bounded fit transport is shared.
 */
export class ViewportFitCoordinator extends FirstLatestCoordinator {}
