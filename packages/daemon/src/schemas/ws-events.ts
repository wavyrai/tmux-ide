/**
 * Compatibility re-exports for the unified `/ws/events` protocol.
 *
 * The canonical, browser-safe schemas live in `@tmux-ide/contracts`. Keep this
 * module so existing daemon imports do not need to move in lock-step.
 */

export {
  DaemonEventClientFrameSchemaZ as ClientFrameSchemaZ,
  DaemonEventServerFrameSchemaZ as ServerFrameSchemaZ,
  DaemonSessionSnapshotSchemaZ as SessionSnapshotSchemaZ,
} from "@tmux-ide/contracts";

export type {
  DaemonEventClientFrame as ClientFrame,
  DaemonEventServerFrame as ServerFrame,
  DaemonSessionSnapshot as SessionSnapshot,
} from "@tmux-ide/contracts";
