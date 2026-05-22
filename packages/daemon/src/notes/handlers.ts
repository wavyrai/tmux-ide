/**
 * HTTP handlers for the Notes feature. Mounts two routes on a Hono
 * app:
 *
 *   GET  /api/project/:name/notes  → { note: Note }
 *   PUT  /api/project/:name/notes  body: { content: string }
 *
 * The handlers resolve the session by name (via the supplied
 * `discoverSessions` injection) and delegate to `./service.ts` for
 * I/O. No business logic here — the file is a thin translation
 * layer so the service can be exercised directly in unit tests.
 */

import type { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { UpdateNoteRequestSchemaZ, type Note } from "@tmux-ide/contracts";
import { readNote, writeNote } from "./service.ts";

export interface NotesHandlerDeps {
  /** Returns the session metadata or null. Injected so tests can
   *  stub session discovery without booting tmux. */
  resolveSession(name: string): { name: string; dir: string } | null;
  /** Optional broadcast hook — fires after a successful write so
   *  WS subscribers can refetch. The Notes feature uses a generic
   *  "notes.changed" frame; if the host wires no broadcaster the
   *  feature still works in poll-only mode. */
  onChanged?(sessionName: string): void;
}

export function attachNotesRoutes(app: Hono, deps: NotesHandlerDeps): void {
  app.get("/api/project/:name/notes", (c) => {
    const name = c.req.param("name");
    const session = deps.resolveSession(name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const record = readNote(session.dir);
    const note: Note = {
      sessionName: name,
      content: record.content,
      updatedAt: record.updatedAt,
    };
    return c.json({ note });
  });

  app.put("/api/project/:name/notes", zValidator("json", UpdateNoteRequestSchemaZ), (c) => {
    const name = c.req.param("name");
    const session = deps.resolveSession(name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const body = c.req.valid("json");
    const record = writeNote(session.dir, body.content);
    deps.onChanged?.(name);
    const note: Note = {
      sessionName: name,
      content: record.content,
      updatedAt: record.updatedAt,
    };
    return c.json({ note });
  });
}
