export { TmuxError } from "./errors.ts";
export { runTmux, _setExecutor, _setSpawner, _getSpawner } from "./runner.ts";
export {
  attachSession,
  createDetachedSession,
  getSessionCwd,
  getSessionState,
  getSessionVariable,
  hasSession,
  killSession,
  runSessionCommand,
  setSessionEnvironment,
  setSessionVariable,
} from "./sessions.ts";
export {
  capturePane,
  captureRecent,
  getPaneCurrentCommand,
  listPanes,
  selectPane,
  sendKeys,
  sendLiteral,
  setPaneOption,
  setPaneTitle,
  splitPane,
  type CapturePaneOptions,
  type SendKeysOptions,
  type TmuxPaneInfo,
} from "./panes.ts";
export { isProcessAlive, startSessionMonitor, stopSessionMonitor } from "./monitor.ts";
export { resolveTarget, type ResolvedPane, type TmuxPaneTarget } from "./targeting.ts";
