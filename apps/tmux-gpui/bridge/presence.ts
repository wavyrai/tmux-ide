import { z } from "zod";
import type { PaneStreamRuntimeClient } from "../../../packages/daemon-client/src/pane-stream-client.ts";

export const presenceSchema = z
  .object({
    kind: z.literal("presence"),
    active: z.boolean(),
    revision: z.number().int().nonnegative().safe().default(0),
  })
  .strict();

/** Returning to the foreground asks for input only; geometry follows a fresh viewport. */
export async function applyPresence(
  runtime: Pick<PaneStreamRuntimeClient, "setPresence" | "releaseAuthority" | "requestAuthority">,
  active: boolean,
): Promise<void> {
  runtime.setPresence(active ? "foreground" : "background");
  if (active) {
    await runtime.requestAuthority("input");
    return;
  }
  for (const authority of ["input", "geometry"] as const) {
    // Presence can revoke the local grant before the release ACK arrives.
    // Release the connection claim even when it no longer owns the authority.
    await runtime.releaseAuthority(authority);
  }
}
