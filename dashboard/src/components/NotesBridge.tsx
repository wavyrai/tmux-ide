/**
 * NotesBridge — host wiring for the Notes widget. Owns the canonical
 * server state (content + updatedAt + saving + error) and pushes it
 * through `setOptions` so the Solid widget can stay prop-driven.
 *
 * Pattern: this file is the "bridge" referenced by the feature
 * framework — it's the only place the dashboard touches the
 * `/api/project/:name/notes` endpoints directly. The widget below
 * never fetches.
 */

import { createMemo, createResource, createSignal, type JSX } from "solid-js";
import { Effect } from "effect";
import { mountNotes, type NotesMountOptions } from "@tmux-ide/v2-solid-widgets";
import { WidgetHost } from "@tmux-ide/v2-solid-widgets";
import { API_BASE } from "@/lib/api";
import { fetchNote, saveNote, NotesApiError } from "@/lib/notes";

interface NotesBridgeProps {
  projectName: string;
}

export function NotesBridge(props: NotesBridgeProps): JSX.Element {
  const [bumpTick, setBumpTick] = createSignal(0);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const [note] = createResource(
    () => ({ projectName: props.projectName, tick: bumpTick() }),
    async ({ projectName }) => {
      try {
        return await Effect.runPromise(fetchNote(projectName));
      } catch {
        return { sessionName: projectName, content: "", updatedAt: null };
      }
    },
  );

  async function onSave(content: string): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      await Effect.runPromise(saveNote(props.projectName, content));
      setBumpTick((t) => t + 1);
    } catch (err) {
      const message =
        err instanceof NotesApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      setError(message);
    } finally {
      setSaving(false);
    }
  }

  const options = createMemo<NotesMountOptions>(() => ({
    sessionName: props.projectName,
    apiBaseUrl: API_BASE,
    bearerToken: null,
    content: note()?.content ?? "",
    updatedAt: note()?.updatedAt ?? null,
    saving: saving(),
    error: error(),
    onSave: (content: string) => void onSave(content),
  }));

  return (
    <div data-testid="notes-bridge" class="flex h-full w-full min-h-0">
      <WidgetHost mount={mountNotes} options={options} class="h-full w-full" />
    </div>
  );
}
