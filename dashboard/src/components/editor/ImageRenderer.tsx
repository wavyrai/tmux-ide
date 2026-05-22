/**
 * Image renderer — fetches the file via the daemon's
 * `/api/project/:name/image/:file` endpoint, which returns a base64
 * `data:` URL with the right MIME. Falls back to `file.content` if a
 * session name isn't provided.
 *
 * Includes a small zoom + pan affordance: wheel zooms toward the
 * pointer (1.1× per notch, clamped to 0.1×..16×), drag pans, the
 * reset button restores the contain-fit view.
 */

import { Maximize2, ZoomIn, ZoomOut } from "lucide-solid";
import { createResource, createSignal, Show, type JSX } from "solid-js";
import { API_BASE } from "@/lib/api";
import type { ManagedFile } from "@/lib/editor/types";

interface ImageRendererProps {
  file: ManagedFile;
  sessionName?: string;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 16;
const ZOOM_STEP = 1.1;

async function fetchImageDataUrl(sessionName: string, filePath: string): Promise<string> {
  const normalized = filePath.replace(/^\/+/g, "");
  const url = `${API_BASE}/api/project/${encodeURIComponent(sessionName)}/image/${encodeURI(normalized)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image fetch failed: ${res.status}`);
  const body = (await res.json()) as { dataUrl: string };
  return body.dataUrl;
}

function clampZoom(z: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
}

export function ImageRenderer(props: ImageRendererProps): JSX.Element {
  const fileName = () => props.file.path.split("/").pop() ?? props.file.path;
  const [dataUrl] = createResource<string | null, { sessionName: string; path: string }>(
    () =>
      props.sessionName
        ? { sessionName: props.sessionName, path: props.file.path }
        : (null as unknown as { sessionName: string; path: string }),
    async (key) => {
      if (!key) return null;
      try {
        return await fetchImageDataUrl(key.sessionName, key.path);
      } catch {
        return null;
      }
    },
  );

  const src = () => {
    if (props.sessionName) {
      const fetched = dataUrl();
      return fetched ?? "";
    }
    return props.file.content;
  };

  const [zoom, setZoom] = createSignal(1);
  const [tx, setTx] = createSignal(0);
  const [ty, setTy] = createSignal(0);
  // Default to fit-to-view (CSS `object-contain`). Drops to manual
  // transform on first wheel/drag/zoom-button event.
  const [reset, setReset] = createSignal(true);

  function resetView() {
    setZoom(1);
    setTx(0);
    setTy(0);
    setReset(true);
  }

  function onWheel(ev: WheelEvent) {
    if (!src()) return;
    ev.preventDefault();
    const factor = ev.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    setZoom((z) => clampZoom(z * factor));
    setReset(false);
  }

  let dragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let txStart = 0;
  let tyStart = 0;
  function onPointerDown(ev: PointerEvent) {
    if (!src()) return;
    dragging = true;
    dragStartX = ev.clientX;
    dragStartY = ev.clientY;
    txStart = tx();
    tyStart = ty();
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
  }
  function onPointerMove(ev: PointerEvent) {
    if (!dragging) return;
    setTx(txStart + (ev.clientX - dragStartX));
    setTy(tyStart + (ev.clientY - dragStartY));
    setReset(false);
  }
  function onPointerUp(ev: PointerEvent) {
    dragging = false;
    (ev.currentTarget as HTMLElement).releasePointerCapture(ev.pointerId);
  }

  return (
    <div
      data-testid="editor-image-renderer"
      class="relative flex h-full min-h-0 flex-col bg-[var(--bg)]"
    >
      <Show when={src()}>
        <div class="absolute right-3 top-3 z-10 inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--surface)] p-0.5 text-[var(--dim)]">
          <button
            type="button"
            data-testid="editor-image-zoom-out"
            aria-label="Zoom out"
            onClick={() => {
              setZoom((z) => clampZoom(z / ZOOM_STEP));
              setReset(false);
            }}
            class="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--surface-active)] hover:text-[var(--fg)]"
          >
            <ZoomOut class="h-3.5 w-3.5" />
          </button>
          <span class="px-1 text-xs tabular-nums">{Math.round(zoom() * 100)}%</span>
          <button
            type="button"
            data-testid="editor-image-zoom-in"
            aria-label="Zoom in"
            onClick={() => {
              setZoom((z) => clampZoom(z * ZOOM_STEP));
              setReset(false);
            }}
            class="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--surface-active)] hover:text-[var(--fg)]"
          >
            <ZoomIn class="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            data-testid="editor-image-zoom-reset"
            aria-label="Fit to view"
            onClick={resetView}
            class="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--surface-active)] hover:text-[var(--fg)]"
          >
            <Maximize2 class="h-3.5 w-3.5" />
          </button>
        </div>
      </Show>
      <div
        data-testid="editor-image-canvas"
        class="flex h-full min-h-0 items-center justify-center overflow-hidden p-4"
        style={{ cursor: src() ? "grab" : "default", "touch-action": "none" }}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <Show
          when={src()}
          fallback={
            <Show
              when={!dataUrl.loading}
              fallback={<span class="text-sm text-[var(--dim)]">loading…</span>}
            >
              <span class="text-sm text-[var(--red-foreground,var(--red))]">
                Failed to load image
              </span>
            </Show>
          }
        >
          <img
            src={src()}
            alt={fileName()}
            draggable={false}
            class={reset() ? "max-h-full max-w-full object-contain" : ""}
            style={
              reset()
                ? undefined
                : {
                    transform: `translate(${tx()}px, ${ty()}px) scale(${zoom()})`,
                    "transform-origin": "center",
                    "max-width": "none",
                    "max-height": "none",
                  }
            }
          />
        </Show>
      </div>
    </div>
  );
}
