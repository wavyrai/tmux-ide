/**
 * Notes client — Effect-wrapped wrappers around GET / PUT
 * /api/project/:name/notes. Shape lives in `@tmux-ide/contracts`
 * (`notes-contract.ts`); imports here only carry the types.
 *
 * Used by `NotesBridge.tsx`. Adding new Notes API endpoints? Wire
 * them next to these two; the bridge consumes them through `Effect`.
 */

import { Effect, Data } from "effect";
import type { Note } from "@tmux-ide/contracts";
import { API_BASE } from "@/lib/api";

export class NotesApiError extends Data.TaggedError("NotesApiError")<{
  readonly status: number;
  readonly message: string;
}> {}

function failed(res: Response): Effect.Effect<never, NotesApiError> {
  return Effect.tryPromise({
    try: async () => {
      let message = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body?.error) message = body.error;
      } catch {
        /* status-only */
      }
      throw new NotesApiError({ status: res.status, message });
    },
    catch: (cause) =>
      cause instanceof NotesApiError
        ? cause
        : new NotesApiError({ status: res.status, message: String(cause) }),
  });
}

export function fetchNote(sessionName: string): Effect.Effect<Note, NotesApiError> {
  return Effect.tryPromise({
    try: async () => {
      const res = await fetch(`${API_BASE}/api/project/${encodeURIComponent(sessionName)}/notes`, {
        cache: "no-store",
      });
      if (!res.ok) throw new NotesApiError({ status: res.status, message: `HTTP ${res.status}` });
      const body = (await res.json()) as { note: Note };
      return body.note;
    },
    catch: (cause) =>
      cause instanceof NotesApiError
        ? cause
        : new NotesApiError({
            status: 0,
            message: cause instanceof Error ? cause.message : String(cause),
          }),
  });
}

export function saveNote(sessionName: string, content: string): Effect.Effect<Note, NotesApiError> {
  return Effect.tryPromise({
    try: async () => {
      const res = await fetch(`${API_BASE}/api/project/${encodeURIComponent(sessionName)}/notes`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body?.error) message = body.error;
        } catch {
          /* status-only */
        }
        throw new NotesApiError({ status: res.status, message });
      }
      const body = (await res.json()) as { note: Note };
      return body.note;
    },
    catch: (cause) =>
      cause instanceof NotesApiError
        ? cause
        : new NotesApiError({
            status: 0,
            message: cause instanceof Error ? cause.message : String(cause),
          }),
  });
}
