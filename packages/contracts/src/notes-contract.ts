/**
 * Notes feature — per-project markdown scratchpad.
 *
 * Single source of truth for the wire shape between the daemon's
 * `/api/project/:name/notes` handlers, the dashboard client helper,
 * and the Solid widget. Both ends import these schemas; the daemon
 * uses Zod for runtime validation on PUT, the dashboard uses the
 * inferred types for compile-time safety only.
 */

import { z } from "zod";

export const NoteSchemaZ = z.object({
  /** Session name the note belongs to (matches a tmux-ide project). */
  sessionName: z.string(),
  /** Markdown body. Empty string when the project has no notes yet. */
  content: z.string(),
  /** ISO-8601 timestamp of the last write, or null if no note exists. */
  updatedAt: z.string().nullable(),
});

export type Note = z.infer<typeof NoteSchemaZ>;

export const NoteResponseSchemaZ = z.object({
  note: NoteSchemaZ,
});
export type NoteResponse = z.infer<typeof NoteResponseSchemaZ>;

export const UpdateNoteRequestSchemaZ = z.object({
  content: z.string().max(1_000_000, "Note exceeds 1 MB"),
});
export type UpdateNoteRequest = z.infer<typeof UpdateNoteRequestSchemaZ>;
