/** Private tmux pane options used only to correlate/suppress interaction hooks. */
export const INTERNAL_SEND_OPERATION_OPTION = "@tmux_ide_send_operation";
export const INTERNAL_READ_OPERATION_OPTION = "@tmux_ide_read_operation";

import { randomUUID } from "node:crypto";

const INTERNAL_READ_PREFIX = "tmux-ide-internal-read-v2:";
const INTERNAL_READ_TTL_MS = 10_000;
const INTERNAL_READ_CAPACITY = 512;
const internalReads = new Map<string, { readonly paneId: string; readonly expiresAt: number }>();

/**
 * Register one bounded, one-use product capture. A marker-shaped tmux option
 * alone is never trusted: the observer must redeem this in-memory fact for the
 * exact pane and read operation before it suppresses any external activity.
 */
export function registerInternalReadOperation(runtimePaneId: string): string {
  const now = Date.now();
  for (const [marker, registration] of internalReads) {
    if (registration.expiresAt <= now) internalReads.delete(marker);
  }
  while (internalReads.size >= INTERNAL_READ_CAPACITY) {
    internalReads.delete(internalReads.keys().next().value!);
  }
  const marker = `${INTERNAL_READ_PREFIX}${randomUUID()}`;
  internalReads.set(marker, { paneId: runtimePaneId, expiresAt: now + INTERNAL_READ_TTL_MS });
  return marker;
}

export function consumeInternalReadOperation(
  marker: string | null,
  runtimePaneId: string,
  operationKind: "workspace.pane.send" | "workspace.pane.read",
): boolean {
  if (marker === null || !marker.startsWith(INTERNAL_READ_PREFIX)) return false;
  const registration = internalReads.get(marker);
  if (!registration) return false;
  internalReads.delete(marker);
  return (
    operationKind === "workspace.pane.read" &&
    registration.paneId === runtimePaneId &&
    registration.expiresAt > Date.now()
  );
}
