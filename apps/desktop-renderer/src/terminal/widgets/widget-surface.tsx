import { Match, Show, Switch, type JSX } from "solid-js";

import { MarkdownView } from "./markdown-view.tsx";
import {
  IMAGE_WIDGET_ID,
  MARKDOWN_WIDGET_ID,
  imageWidgetDataUrl,
  type ImageWidgetArgs,
  type MarkdownWidgetArgs,
  type WidgetResolution,
} from "./widget-registry.ts";

/**
 * The rich surface a pane shows instead of its grid.
 *
 * It is an OVERLAY, never a replacement. The emulator stays mounted, visible to
 * the accessibility tree and — crucially — focusable underneath, because the
 * pane has not stopped being a pane: the process is still running, and Ctrl-C
 * still has to reach it. Hiding the grid with `display:none` or
 * `visibility:hidden` would take its textarea out of the focus order and strand
 * the user inside a widget they cannot leave, which is the one failure this
 * feature is not allowed to have.
 */

export interface WidgetSurfaceProps {
  readonly resolution: WidgetResolution;
  /** Focus the emulator underneath, so keys keep reaching the pane. */
  readonly onRequestFocus?: () => void;
}

export function WidgetSurface(props: WidgetSurfaceProps): JSX.Element {
  const label = (): string =>
    props.resolution.status === "ready" ? props.resolution.definition.label : "Widget";

  return (
    <div
      class="widget-surface"
      data-widget={props.resolution.status === "ready" ? props.resolution.definition.id : "invalid"}
      data-status={props.resolution.status}
      // Pointer-down focuses the pane rather than the overlay: clicking a
      // rendered document must not be the thing that makes Ctrl-C stop working.
      onPointerDown={() => props.onRequestFocus?.()}
    >
      <div class="widget-surface__bar">
        <span class="widget-surface__label">{label()}</span>
        <span class="widget-surface__hint">Ctrl-C returns this pane to a shell</span>
      </div>
      <div class="widget-surface__body">
        <Switch>
          <Match
            when={props.resolution.status === "unknown-widget" ? props.resolution : null}
            keyed
          >
            {(resolution) => (
              <p class="widget-surface__refusal" role="status">
                This pane asked for a <code>{resolution.id}</code> widget, which this build does not
                have. The pane is still a terminal.
              </p>
            )}
          </Match>
          <Match
            when={props.resolution.status === "invalid-arguments" ? props.resolution : null}
            keyed
          >
            {(resolution) => (
              <p class="widget-surface__refusal" role="status">
                The <code>{resolution.id}</code> widget was given arguments it cannot render:{" "}
                {resolution.message}
              </p>
            )}
          </Match>
          <Match when={props.resolution.status === "ready" ? props.resolution : null} keyed>
            {(resolution) => (
              <Switch>
                <Match when={resolution.definition.id === MARKDOWN_WIDGET_ID}>
                  <MarkdownView text={(resolution.args as MarkdownWidgetArgs).text} />
                </Match>
                <Match when={resolution.definition.id === IMAGE_WIDGET_ID}>
                  <ImageWidgetView args={resolution.args as ImageWidgetArgs} />
                </Match>
              </Switch>
            )}
          </Match>
        </Switch>
      </div>
    </div>
  );
}

function ImageWidgetView(props: { readonly args: ImageWidgetArgs }): JSX.Element {
  return (
    <figure class="widget-image">
      {/* A GIF animates here for free: it is an ordinary <img>, and the bytes
          arrived as a data URL, which the renderer's CSP already permits
          (img-src 'self' data:). No decoder and no network fetch is involved. */}
      <img
        class="widget-image__frame"
        src={imageWidgetDataUrl(props.args)}
        alt={props.args.alt ?? props.args.name ?? "Image rendered in a terminal pane"}
      />
      <Show when={props.args.name}>
        <figcaption>{props.args.name}</figcaption>
      </Show>
    </figure>
  );
}
