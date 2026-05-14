/**
 * Image renderer — Solid port of emdash's `image-renderer.tsx`.
 *
 * `file.content` carries the data URL fetched by the daemon (see
 * §4 of docs/goal-17-code-editor.md: the new
 * `/api/project/:name/file-image/:path` endpoint lands alongside
 * G17-P4 wiring). Until then, callers feed a data URL directly.
 */

import type { ManagedFile } from "@/lib/editor/types";

interface ImageRendererProps {
  file: ManagedFile;
}

export function ImageRenderer(props: ImageRendererProps) {
  const fileName = () => props.file.path.split("/").pop() ?? props.file.path;
  return (
    <div
      data-testid="editor-image-renderer"
      class="flex h-full items-center justify-center overflow-auto p-4"
    >
      <img src={props.file.content} alt={fileName()} class="max-h-full max-w-full object-contain" />
    </div>
  );
}
