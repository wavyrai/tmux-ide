import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  PaneWidgetDescriptorSchemaZ,
  type WidgetMarker,
  type RichCardWidgetArgs,
} from "@tmux-ide/contracts";
import { MarkdownDocument } from "./markdown-document";

import { createWidgetAssetResource, type WidgetAssetReader } from "./widget-asset-resource";
export type { WidgetAssetReader } from "./widget-asset-resource";

export function WidgetRenderer({
  marker,
  readAsset,
  onAction,
}: {
  marker: WidgetMarker;
  readAsset: WidgetAssetReader;
  onAction?: (text: string) => void;
}) {
  const parsed = useMemo(
    () => PaneWidgetDescriptorSchemaZ.safeParse({ id: marker.id, args: marker.args }),
    [marker],
  );
  if (!parsed.success)
    return (
      <p role="status">
        This widget is unavailable or has invalid content. The terminal remains available.
      </p>
    );
  const widget = parsed.data;
  if (widget.id === "card") return <CardDocument card={widget.args} onAction={onAction} />;
  if ("assetId" in widget.args)
    return (
      <AssetDocument
        key={widget.args.assetId}
        id={widget.args.assetId}
        kind={widget.id}
        alt={widget.id === "image" ? widget.args.alt : undefined}
        readAsset={readAsset}
      />
    );
  if (widget.id === "markdown") return <MarkdownDocument text={widget.args.text} />;
  return (
    <img
      className="live-widget-image"
      src={`data:${widget.args.media};base64,${widget.args.data}`}
      alt={widget.args.alt ?? widget.args.name ?? "Pane image"}
    />
  );
}
function AssetDocument({
  id,
  kind,
  alt,
  readAsset,
}: {
  id: string;
  kind: "markdown" | "image";
  alt?: string;
  readAsset: WidgetAssetReader;
}) {
  const resource = useMemo(
    () => createWidgetAssetResource(id, kind, readAsset),
    [id, kind, readAsset],
  );
  const state = useSyncExternalStore(
    resource.subscribe,
    resource.getSnapshot,
    resource.getSnapshot,
  );
  useEffect(() => {
    void resource.load();
    return () => resource.cancel();
  }, [resource]);
  if (state.status === "error")
    return (
      <div data-slot="widget-status" role="status">
        <p>Widget content could not be loaded from this machine.</p>
        <button type="button" onClick={() => void resource.load()}>
          Retry
        </button>
      </div>
    );
  if (state.status === "loading")
    return (
      <p data-slot="widget-status" role="status">
        Loading widget…
      </p>
    );
  if (state.document.kind === "image")
    return (
      <img
        className="live-widget-image"
        src={state.document.src}
        alt={alt ?? state.document.name}
      />
    );
  return <MarkdownDocument text={state.document.text} />;
}
function CardDocument({
  card,
  onAction,
}: {
  card: RichCardWidgetArgs;
  onAction?: (text: string) => void;
}) {
  return (
    <article data-slot="widget-card" className="live-widget-card">
      <h2>{card.title}</h2>
      {card.subtitle && <p>{card.subtitle}</p>}
      {card.items.map((item, key) => {
        switch (item.type) {
          case "text":
            return <p key={key}>{item.text}</p>;
          case "badge":
            return (
              <span key={key} className="live-widget-badge" data-tone={item.tone}>
                {item.text}
              </span>
            );
          case "code":
            return (
              <pre key={key}>
                <code>{item.code}</code>
              </pre>
            );
          case "progress":
            return (
              <label key={key}>
                {item.label}
                <progress max={100} value={item.value} aria-label={item.label ?? "Progress"} />
              </label>
            );
          case "button":
            return (
              <button
                key={key}
                type="button"
                disabled={!onAction}
                onClick={() => onAction?.(item.input + (item.submit ? "\r" : ""))}
              >
                {item.label}
              </button>
            );
        }
      })}
    </article>
  );
}
