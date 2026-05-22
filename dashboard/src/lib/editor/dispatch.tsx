/**
 * Per-filetype renderer dispatch.
 *
 * Single Solid component, drop-in callable from any host:
 *
 *   <FileRenderer file={file()} modelRootPath={root()} />
 *
 * Maps `file.kind` to one of the per-kind renderers in
 * `dashboard/src/components/editor/`. The `text` slot is reserved
 * for the Monaco code editor — it lands in G17-P4 alongside the
 * Files view wire-up; until then it renders a small placeholder so
 * the dispatch table stays exhaustive (and the typecheck stays
 * honest).
 */

import { Match, Switch, type JSX } from "solid-js";
import type { ManagedFile } from "./types";
import { BinaryRenderer } from "@/components/editor/BinaryRenderer";
import { ImageRenderer } from "@/components/editor/ImageRenderer";
import { MarkdownRenderer } from "@/components/editor/MarkdownRenderer";
import { SvgRenderer } from "@/components/editor/SvgRenderer";
import { TooLargeRenderer } from "@/components/editor/TooLargeRenderer";

export interface FileRendererProps {
  file: ManagedFile;
  /** Workspace root used to build Monaco model URIs. */
  modelRootPath: string;
  /**
   * Session name used by renderers that fetch from the daemon
   * (currently the image renderer's data-URL pipeline).
   */
  sessionName?: string;
  /**
   * Optional source-toggle handler. Markdown + SVG show an "Edit
   * source" affordance only when this is provided.
   */
  onEditSource?: (filePath: string) => void;
}

export function FileRenderer(props: FileRendererProps): JSX.Element {
  return (
    <Switch fallback={<BinaryRenderer file={props.file} sessionName={props.sessionName} />}>
      <Match when={props.file.kind === "image"}>
        <ImageRenderer file={props.file} sessionName={props.sessionName} />
      </Match>
      <Match when={props.file.kind === "svg"}>
        <SvgRenderer
          filePath={props.file.path}
          modelRootPath={props.modelRootPath}
          onEditSource={props.onEditSource}
        />
      </Match>
      <Match when={props.file.kind === "markdown"}>
        <MarkdownRenderer
          filePath={props.file.path}
          modelRootPath={props.modelRootPath}
          onEditSource={props.onEditSource}
        />
      </Match>
      <Match when={props.file.kind === "text"}>
        <TextRendererPlaceholder file={props.file} />
      </Match>
      <Match when={props.file.kind === "too-large"}>
        <TooLargeRenderer file={props.file} />
      </Match>
      <Match when={props.file.kind === "binary"}>
        <BinaryRenderer file={props.file} sessionName={props.sessionName} />
      </Match>
    </Switch>
  );
}

/**
 * `text` renderer placeholder — replaced by a leased Monaco code
 * editor in G17-P4 (Files view wire-up). The placeholder still ships
 * with a stable testid so the dispatch tests can assert it.
 */
function TextRendererPlaceholder(props: { file: ManagedFile }) {
  const fileName = () => props.file.path.split("/").pop() ?? props.file.path;
  return (
    <div
      data-testid="editor-text-placeholder"
      class="flex h-full flex-col items-center justify-center gap-2 text-[var(--dim)]"
    >
      <code class="font-mono text-base">{fileName()}</code>
      <p class="text-sm opacity-70">Monaco code editor lands in G17-P4 (Files view wire-up).</p>
    </div>
  );
}
