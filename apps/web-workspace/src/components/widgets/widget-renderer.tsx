import { useEffect, useMemo, useState } from "react";
import {
  PaneWidgetDescriptorSchemaZ,
  WidgetAssetSchemaZ,
  type WidgetAsset,
  type WidgetMarker,
  type RichCardWidgetArgs,
} from "@tmux-ide/contracts";
import { MarkdownDocument } from "./markdown-document";

export type WidgetAssetReader = (assetId: string) => Promise<WidgetAsset>;

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
  const [asset, setAsset] = useState<WidgetAsset | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    void readAsset(id)
      .then((value) => {
        const valid = WidgetAssetSchemaZ.parse(value);
        if (
          valid.assetId !== id ||
          (kind === "markdown"
            ? valid.media !== "text/markdown"
            : !valid.media.startsWith("image/"))
        )
          throw Error("Widget asset does not match this pane.");
        if (!disposed) setAsset(valid);
      })
      .catch(() => {
        if (!disposed) setError("Widget content could not be loaded from this machine.");
      });
    return () => {
      disposed = true;
    };
  }, [id, kind, readAsset]);
  if (error) return <p role="status">{error}</p>;
  if (!asset) return <p role="status">Loading widget…</p>;
  if (kind === "image")
    return (
      <img
        className="live-widget-image"
        src={`data:${asset.media};base64,${asset.data}`}
        alt={alt ?? asset.name}
      />
    );
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(atob(asset.data), (c) => c.charCodeAt(0)),
    );
    return <MarkdownDocument text={text} />;
  } catch {
    return <p role="status">The Markdown asset is not valid UTF-8.</p>;
  }
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
