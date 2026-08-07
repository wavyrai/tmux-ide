import { For, Match, Show, Switch, createResource, type JSX } from "solid-js";

import { MarkdownView } from "./markdown-view.tsx";
import {
  CARD_WIDGET_ID,
  IMAGE_WIDGET_ID,
  MARKDOWN_WIDGET_ID,
  imageWidgetDataUrl,
  isAssetImageWidget,
  isAssetMarkdownWidget,
  type AssetImageWidgetArgs,
  type AssetMarkdownWidgetArgs,
  type ImageWidgetArgs,
  type InlineImageWidgetArgs,
  type MarkdownWidgetArgs,
  type RichCardWidgetArgs,
  type WidgetResolution,
} from "./widget-registry.ts";
import {
  loadWidgetAsset,
  widgetAssetDataUrl,
  widgetAssetText,
  type WidgetAssetLoader,
} from "./widget-asset-loader.ts";

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
  readonly loadAsset?: WidgetAssetLoader;
  /** Writes an explicit card action back to the owning pane. */
  readonly onAction?: (input: string) => void;
}

export function WidgetSurface(props: WidgetSurfaceProps): JSX.Element {
  const label = (): string =>
    props.resolution.status === "ready" ? props.resolution.definition.label : "Widget";

  return (
    <div
      class="widget-surface"
      data-widget={props.resolution.status === "ready" ? props.resolution.definition.id : "invalid"}
      data-status={props.resolution.status}
      /*
       * Clicking the document must not be the thing that makes Ctrl-C stop
       * working — and by default it is. A mousedown on ordinary content moves
       * focus off the emulator's textarea to the body, so the pane silently
       * stops receiving keys the moment the user touches what it is showing.
       * An e2e run caught exactly that: the document rendered, and the pane
       * could no longer be interrupted.
       *
       * Focus is therefore restored on mouse-UP, and only when the user did not
       * leave a selection behind. A completed drag-select keeps focus where it
       * is so the selection survives long enough to be copied; a plain click
       * hands the pane back its keyboard.
       */
      onPointerDown={() => props.onRequestFocus?.()}
      onMouseUp={() => {
        const selection = document.getSelection();
        if (!selection || selection.isCollapsed) props.onRequestFocus?.();
      }}
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
                  <MarkdownWidgetView
                    args={resolution.args as MarkdownWidgetArgs}
                    loadAsset={props.loadAsset}
                  />
                </Match>
                <Match when={resolution.definition.id === IMAGE_WIDGET_ID}>
                  <ImageWidgetView
                    args={resolution.args as ImageWidgetArgs}
                    loadAsset={props.loadAsset}
                  />
                </Match>
                <Match when={resolution.definition.id === CARD_WIDGET_ID}>
                  <CardWidgetView
                    args={resolution.args as RichCardWidgetArgs}
                    onAction={props.onAction}
                  />
                </Match>
              </Switch>
            )}
          </Match>
        </Switch>
      </div>
    </div>
  );
}

function MarkdownWidgetView(props: {
  readonly args: MarkdownWidgetArgs;
  readonly loadAsset?: WidgetAssetLoader;
}): JSX.Element {
  return (
    <Show
      when={isAssetMarkdownWidget(props.args) ? props.args : null}
      keyed
      fallback={<MarkdownView text={(props.args as { text: string }).text} />}
    >
      {(args) => <AssetMarkdownWidget args={args} loadAsset={props.loadAsset} />}
    </Show>
  );
}

function AssetMarkdownWidget(props: {
  readonly args: AssetMarkdownWidgetArgs;
  readonly loadAsset?: WidgetAssetLoader;
}): JSX.Element {
  const [asset] = createResource(() => props.args.assetId, props.loadAsset ?? loadWidgetAsset);
  return (
    <Switch>
      <Match when={asset.error}>
        <p class="widget-surface__refusal" role="status">
          This Markdown asset could not be loaded. The pane is still a terminal.
        </p>
      </Match>
      <Match when={asset()} keyed>
        {(value) => <MarkdownView text={widgetAssetText(value)} />}
      </Match>
      <Match when={true}>
        <p class="widget-surface__loading" role="status">
          Loading Markdown…
        </p>
      </Match>
    </Switch>
  );
}

function ImageWidgetView(props: {
  readonly args: ImageWidgetArgs;
  readonly loadAsset?: WidgetAssetLoader;
}): JSX.Element {
  return (
    <Show
      when={isAssetImageWidget(props.args) ? props.args : null}
      keyed
      fallback={<InlineImageWidget args={props.args as InlineImageWidgetArgs} />}
    >
      {(args) => <AssetImageWidget args={args} loadAsset={props.loadAsset} />}
    </Show>
  );
}

function InlineImageWidget(props: { readonly args: InlineImageWidgetArgs }): JSX.Element {
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

function AssetImageWidget(props: {
  readonly args: AssetImageWidgetArgs;
  readonly loadAsset?: WidgetAssetLoader;
}): JSX.Element {
  const [asset] = createResource(() => props.args.assetId, props.loadAsset ?? loadWidgetAsset);
  return (
    <Switch>
      <Match when={asset.error}>
        <p class="widget-surface__refusal" role="status">
          This image asset could not be loaded. The pane is still a terminal.
        </p>
      </Match>
      <Match when={asset()} keyed>
        {(value) => (
          <figure class="widget-image">
            <img
              class="widget-image__frame"
              src={widgetAssetDataUrl(value)}
              alt={props.args.alt ?? props.args.name ?? value.name}
            />
            <figcaption>{props.args.name ?? value.name}</figcaption>
          </figure>
        )}
      </Match>
      <Match when={true}>
        <p class="widget-surface__loading" role="status">
          Loading image…
        </p>
      </Match>
    </Switch>
  );
}

function CardWidgetView(props: {
  readonly args: RichCardWidgetArgs;
  readonly onAction?: (input: string) => void;
}): JSX.Element {
  return (
    <article class="widget-card">
      <header class="widget-card__header">
        <h1>{props.args.title}</h1>
        <Show when={props.args.subtitle}>{(subtitle) => <p>{subtitle()}</p>}</Show>
      </header>
      <div class="widget-card__items">
        <For each={props.args.items}>
          {(item) => (
            <Switch>
              <Match when={item.type === "text" ? item : null} keyed>
                {(textItem) => <p class="widget-card__text">{textItem.text}</p>}
              </Match>
              <Match when={item.type === "badge" ? item : null} keyed>
                {(badge) => (
                  <span class="widget-card__badge" data-tone={badge.tone}>
                    {badge.text}
                  </span>
                )}
              </Match>
              <Match when={item.type === "progress" ? item : null} keyed>
                {(progress) => (
                  <div class="widget-card__progress">
                    <div>
                      <span>{progress.label ?? "Progress"}</span>
                      <strong>{Math.round(progress.value)}%</strong>
                    </div>
                    <progress max="100" value={progress.value} />
                  </div>
                )}
              </Match>
              <Match when={item.type === "code" ? item : null} keyed>
                {(code) => (
                  <pre class="widget-markdown__code" data-language={code.language}>
                    <code>{code.code}</code>
                  </pre>
                )}
              </Match>
              <Match when={item.type === "button" ? item : null} keyed>
                {(button) => (
                  <button
                    type="button"
                    class="widget-card__button"
                    data-tone={button.tone}
                    disabled={!props.onAction}
                    onClick={() => props.onAction?.(`${button.input}${button.submit ? "\r" : ""}`)}
                  >
                    {button.label}
                  </button>
                )}
              </Match>
            </Switch>
          )}
        </For>
      </div>
    </article>
  );
}
