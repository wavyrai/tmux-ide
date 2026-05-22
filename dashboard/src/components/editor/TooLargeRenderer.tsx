/**
 * Too-large file placeholder — shown when the FS layer reports a
 * `truncated` flag. Solid port of emdash's
 * `too-large-renderer.tsx`.
 */

import { FileX } from "lucide-solid";
import type { ManagedFile } from "@/lib/editor/types";

interface TooLargeRendererProps {
  file: ManagedFile;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function TooLargeRenderer(props: TooLargeRendererProps) {
  const fileName = () => props.file.path.split("/").pop() ?? props.file.path;
  return (
    <div
      data-testid="editor-too-large-renderer"
      class="flex h-full flex-col items-center justify-center gap-3 text-[var(--dim)]"
    >
      <FileX class="h-10 w-10 opacity-30" />
      <div class="text-center">
        <p class="text-sm font-medium">{fileName()}</p>
        <p class="mt-1 text-xs opacity-70">File too large to display in the editor</p>
        {props.file.totalSize != null && (
          <p class="mt-0.5 text-xs opacity-50">{formatBytes(props.file.totalSize)}</p>
        )}
      </div>
    </div>
  );
}

// Re-export the formatter for the test suite.
export { formatBytes as _formatBytesForTests };
