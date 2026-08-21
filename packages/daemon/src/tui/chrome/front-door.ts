/**
 * The chrome front door (M25.1) — the tiny, LEAF constants + argv builders the
 * unified app needs to get a session watched without importing the chrome/data
 * graph (app.tsx deliberately never imports the sync fleet-scan modules that
 * {@link ./updater.ts} pulls in; see the FleetSession note there).
 *
 * "Watched" means: stamped with {@link ADOPTED_OPTION} so the background
 * updater enumerates it (VERIFIED inert for a session that never ran `adopt` —
 * none of adopt's status-row/border options are set, so the updater's status/
 * chip var writes land on options nothing reads), and the updater itself
 * ensured up. The sync twin of that flow lives in `updater.ts`
 * (`startUpdaterIfNeeded`); the app uses these argvs with async execFile (the
 * render-loop law).
 */

export {
  ADOPTED_OPTION,
  UPDATER_SESSION,
  adoptMarkArgv,
  updaterProbeArgv,
  updaterSpawnArgv,
} from "../../lib/chrome-front-door.ts";

export {
  PANE_CHROME_BORDER_FORMAT,
  PANE_CHROME_CHIP_OPTION as CHIP_OPTION,
} from "../../lib/pane-chrome.ts";
