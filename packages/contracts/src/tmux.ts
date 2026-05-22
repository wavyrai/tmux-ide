import { z } from "zod";

/**
 * Tmux state schemas — the canonical typed surface for tmux sessions,
 * windows, panes, and pane addressing.
 *
 * Used by:
 *   - packages/tmux-bridge — implementation that shells out to tmux.
 *   - packages/daemon (session-monitor, discovery, command-center) —
 *     materializes these shapes into the live runtime state.
 *   - dashboard — consumes them via the typed REST/SSE clients.
 *
 * Adding a new addressing mode (e.g. byRegex) is intentionally a one-line
 * discriminant change here; bridge resolvers must update in lockstep.
 */

export const TmuxPaneSchemaZ = z.object({
  /** Stable tmux pane id (e.g. `%23`). */
  id: z.string(),
  /** Pane index within its window (zero-based). */
  paneIndex: z.number().int().nonnegative(),
  /** Window index within the session (zero-based). */
  windowIndex: z.number().int().nonnegative(),
  title: z.string().nullable(),
  command: z.string().nullable(),
  active: z.boolean(),
});
export type TmuxPane = z.infer<typeof TmuxPaneSchemaZ>;

export const TmuxWindowSchemaZ = z.object({
  index: z.number().int().nonnegative(),
  name: z.string(),
  panes: z.array(TmuxPaneSchemaZ),
});
export type TmuxWindow = z.infer<typeof TmuxWindowSchemaZ>;

export const TmuxSessionSchemaZ = z.object({
  name: z.string(),
  windows: z.array(TmuxWindowSchemaZ),
  /** Session creation time (epoch milliseconds). */
  created: z.number().int().nonnegative(),
  attached: z.boolean(),
  /** Project directory the session was launched from, when known. */
  projectDir: z.string().nullable(),
});
export type TmuxSession = z.infer<typeof TmuxSessionSchemaZ>;

/**
 * Discriminated union for addressing a pane. The bridge's resolver
 * implements byId/byIndex/byTitle directly; byRole is resolved at the
 * daemon layer (it requires reading the ide.yml-driven role mapping)
 * and translated into a concrete address before reaching the bridge.
 */
export const TmuxPaneTargetSchemaZ = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("byId"), id: z.string() }),
  z.object({ kind: z.literal("byIndex"), index: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("byTitle"), title: z.string() }),
  z.object({ kind: z.literal("byRole"), role: z.string() }),
]);
export type TmuxPaneTarget = z.infer<typeof TmuxPaneTargetSchemaZ>;
