/** Private native boundary: callers must resolve opaque link handles and fence
 * daemon/server/session generation before using this command. Never accept native
 * addresses from clients. Execute argv through the pinned runner without a shell.
 */
export interface NativeWindowLinkAddress {
  sessionId: string;
  windowIndex: number;
  expectedWindowId: string;
  expectedServerPid?: string;
  expectedSessionCreated?: string;
}

export const WINDOW_LINK_GUARD_APPLIED = "link-guard.ok";
export const WINDOW_LINK_GUARD_STALE = "link-guard.stale";

/** if-shell -F and its first branch command do not yield in tmux's command queue.
 * Keep the mutation first and synchronous. Do not insert run-shell/wait-for/UI.
 * This checks a current tuple, not an immutable historical winlink (tmux has none).
 * Use buildNativeWindowLinkPaneSelectGuard for guarded compound pane selection.
 */
export function buildNativeWindowLinkGuard(
  address: NativeWindowLinkAddress,
  action: "select" | "unlink",
): string[] {
  const { sessionId, windowIndex, expectedWindowId } = address;
  if (
    !/^\$(?:0|[1-9]\d{0,15})$/u.test(sessionId) ||
    !/^@(?:0|[1-9]\d{0,15})$/u.test(expectedWindowId) ||
    !Number.isSafeInteger(Number(sessionId.slice(1))) ||
    !Number.isSafeInteger(Number(expectedWindowId.slice(1))) ||
    !Number.isSafeInteger(windowIndex) ||
    windowIndex < 0 ||
    (address.expectedServerPid !== undefined &&
      !/^[1-9][0-9]{0,15}$/u.test(address.expectedServerPid)) ||
    (address.expectedSessionCreated !== undefined &&
      !/^(?:0|[1-9][0-9]{0,15})$/u.test(address.expectedSessionCreated)) ||
    (action !== "select" && action !== "unlink")
  ) {
    throw new Error("Invalid native window link guard address or action");
  }
  const target = `${sessionId}:${windowIndex}`;
  // CANFAIL target lookup makes all three comparisons necessary for missing targets.
  let condition = `#{&&:#{==:#{session_id},${sessionId}},#{&&:#{==:#{window_index},${windowIndex}},#{==:#{window_id},${expectedWindowId}}}}`;
  if (address.expectedServerPid !== undefined)
    condition = `#{&&:#{==:#{pid},${address.expectedServerPid}},${condition}}`;
  if (address.expectedSessionCreated !== undefined)
    condition = `#{&&:#{==:#{session_created},${address.expectedSessionCreated}},${condition}}`;
  const verb = action === "select" ? "select-window" : "unlink-window";
  // Validated native IDs/index contain no quote, separator, or format syntax.
  return [
    "if-shell",
    "-F",
    "-t",
    target,
    condition,
    `${verb} -t '${target}' ; display-message -p '${WINDOW_LINK_GUARD_APPLIED}'`,
    `display-message -p '${WINDOW_LINK_GUARD_STALE}'`,
  ];
}

/** Select an exact link and pane while preserving native user hooks. The window
 * selection hook may yield or move topology, so revalidate after it. A failed
 * second check is indeterminate: the window selection may already have happened.
 */
export function buildNativeWindowLinkPaneSelectGuard(
  address: NativeWindowLinkAddress,
  paneId: string,
): string[] {
  const windowGuard = buildNativeWindowLinkGuard(address, "select");
  if (!/^%(?:0|[1-9]\d{0,15})$/u.test(paneId) || !Number.isSafeInteger(Number(paneId.slice(1)))) {
    throw new Error("Invalid native pane guard address");
  }
  const target = `${address.sessionId}:${address.windowIndex}`;
  const paneCondition = `#{&&:#{==:#{pane_id},${paneId}},#{==:#{window_id},${address.expectedWindowId}}}`;
  const stale = `display-message -p '${WINDOW_LINK_GUARD_STALE}'`;
  const interrupted = "display-message -p 'link-guard.interrupted'";
  // All interpolated IDs are canonical numeric native identities. Braces are
  // tmux command groups, not a host shell or a caller-provided command language.
  const linkCheck = (yes: string, no: string) =>
    `if-shell -F -t '${target}' '${windowGuard[4]!}' { ${yes} } { ${no} }`;
  const paneCheck = (yes: string, no: string) =>
    `if-shell -F -t '${paneId}' '${paneCondition}' { ${yes} } { ${no} }`;
  const selectPane = `select-pane -t '${paneId}' ; display-message -p '${WINDOW_LINK_GUARD_APPLIED}'`;
  const afterHook = paneCheck(linkCheck(selectPane, interrupted), interrupted);
  return [
    "if-shell",
    "-F",
    "-t",
    paneId,
    paneCondition,
    linkCheck(`select-window -t '${target}' ; ${afterHook}`, stale),
    stale,
  ];
}

/** Consume only output associated with this request's own native command boundary.
 * Nonzero completion reports native failure, including last-link unlink refusal.
 * For compound selection this can follow partial mutation; it is not rollback proof.
 * Missing/extra output or interrupted completion is indeterminate, never success;
 * it must not trigger an automatic retry of a potentially completed mutation.
 */
export function classifyNativeWindowLinkGuardResult(
  status: number | null,
  stdout: string,
): "applied" | "stale" | "native-refused" | "indeterminate" {
  if (status === null) return "indeterminate";
  if (status !== 0) return "native-refused";
  const output = stdout.trim();
  if (output === WINDOW_LINK_GUARD_APPLIED) return "applied";
  if (output === WINDOW_LINK_GUARD_STALE) return "stale";
  return "indeterminate";
}
