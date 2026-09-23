import { createHash } from "node:crypto";

/** Shared opaque incarnation identity for catalog and terminal authority. */
export function liveSessionIdForNativeIdentity(
  serverPid: string,
  sessionId: string,
  sessionCreated: string,
) {
  const digest = createHash("sha256")
    .update(`${serverPid}\0${sessionId}\0${sessionCreated}`)
    .digest("hex")
    .slice(0, 20);
  return `live-session.${digest}` as const;
}
