/**
 * Binary file renderer. Shows a hex-dump for small files (< 64 KB)
 * fetched via the daemon's image endpoint (it returns base64, which
 * we decode here and format `00000000  …  ASCII`). Larger files
 * fall through to the placeholder.
 */

import { FileQuestion } from "lucide-solid";
import { createResource, Show, type JSX } from "solid-js";
import { API_BASE } from "@/lib/api";
import type { ManagedFile } from "@/lib/editor/types";

interface BinaryRendererProps {
  file: ManagedFile;
  sessionName?: string;
}

const HEX_DUMP_MAX_BYTES = 64 * 1024;
const HEX_DUMP_FETCH_BYTES = 64 * 1024;

async function fetchBytes(sessionName: string, filePath: string): Promise<Uint8Array | null> {
  const normalized = filePath.replace(/^\/+/g, "");
  const url = `${API_BASE}/api/project/${encodeURIComponent(sessionName)}/image/${encodeURI(normalized)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const body = (await res.json()) as { dataUrl?: string; size?: number };
    if (!body.dataUrl) return null;
    if (typeof body.size === "number" && body.size > HEX_DUMP_MAX_BYTES) return null;
    const comma = body.dataUrl.indexOf(",");
    const base64 = comma === -1 ? body.dataUrl : body.dataUrl.slice(comma + 1);
    const bin = atob(base64);
    const out = new Uint8Array(Math.min(bin.length, HEX_DUMP_FETCH_BYTES));
    for (let i = 0; i < out.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function formatHexDump(bytes: Uint8Array): string {
  const lines: string[] = [];
  const bytesPerRow = 16;
  for (let offset = 0; offset < bytes.length; offset += bytesPerRow) {
    const slice = bytes.subarray(offset, Math.min(offset + bytesPerRow, bytes.length));
    const hex: string[] = [];
    let ascii = "";
    for (let i = 0; i < bytesPerRow; i++) {
      if (i < slice.length) {
        const b = slice[i]!;
        hex.push(b.toString(16).padStart(2, "0"));
        ascii += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".";
      } else {
        hex.push("  ");
        ascii += " ";
      }
    }
    const left = hex.slice(0, 8).join(" ");
    const right = hex.slice(8).join(" ");
    lines.push(`${offset.toString(16).padStart(8, "0")}  ${left}  ${right}  |${ascii}|`);
  }
  return lines.join("\n");
}

export function BinaryRenderer(props: BinaryRendererProps): JSX.Element {
  const fileName = () => props.file.path.split("/").pop() ?? props.file.path;
  const ext = () => props.file.path.split(".").pop()?.toUpperCase();

  const [bytes] = createResource<Uint8Array | null, { sessionName: string; path: string }>(
    () =>
      props.sessionName
        ? { sessionName: props.sessionName, path: props.file.path }
        : (null as unknown as { sessionName: string; path: string }),
    async (key) => {
      if (!key) return null;
      return fetchBytes(key.sessionName, key.path);
    },
  );

  return (
    <div data-testid="editor-binary-renderer" class="flex h-full min-h-0 flex-col bg-[var(--bg)]">
      <Show
        when={bytes()}
        fallback={
          <div class="flex h-full flex-col items-center justify-center gap-3 text-[var(--dim)]">
            <FileQuestion class="h-10 w-10 opacity-30" />
            <div class="text-center">
              <p class="text-sm font-medium">{fileName()}</p>
              <Show when={ext()}>
                <p class="mt-0.5 text-xs opacity-50">{ext()} file</p>
              </Show>
              <Show
                when={!bytes.loading}
                fallback={<p class="mt-1 text-xs opacity-70">loading hex dump…</p>}
              >
                <p class="mt-1 text-xs opacity-70">
                  Binary file — file is larger than 64 KB or fetch failed.
                </p>
              </Show>
            </div>
          </div>
        }
      >
        {(buf) => (
          <>
            <div class="flex h-7 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--dim)]">
              <span class="font-mono">{fileName()}</span>
              <span class="opacity-30">│</span>
              <span>{buf().byteLength.toLocaleString()} bytes</span>
            </div>
            <pre
              data-testid="editor-binary-hex-dump"
              class="m-0 flex-1 overflow-auto bg-[var(--bg)] px-3 py-3 font-mono text-sm leading-[1.5] text-[var(--fg-secondary)]"
            >
              {formatHexDump(buf())}
            </pre>
          </>
        )}
      </Show>
    </div>
  );
}
