import { WidgetAssetSchemaZ, type WidgetAsset } from "@tmux-ide/contracts";

export type WidgetAssetReader = (assetId: string) => Promise<WidgetAsset>;
export type WidgetDocument =
  | { kind: "markdown"; text: string }
  | { kind: "image"; src: string; name: string };
export type WidgetAssetState =
  | { status: "loading" }
  | { status: "ready"; document: WidgetDocument }
  | { status: "error" };

/** One mounted descriptor/reader binding. No assets survive a machine binding change. */
export function createWidgetAssetResource(
  id: string,
  kind: WidgetDocument["kind"],
  readAsset: WidgetAssetReader,
) {
  let epoch = 0;
  let state: WidgetAssetState = { status: "loading" };
  const listeners = new Set<() => void>();
  const publish = (next: WidgetAssetState) => {
    state = next;
    listeners.forEach((listener) => listener());
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    cancel() {
      epoch += 1;
    },
    async load() {
      const request = ++epoch;
      publish({ status: "loading" });
      try {
        const value = await readAsset(id);
        if (request !== epoch) return;
        const asset = WidgetAssetSchemaZ.parse(value);
        if (
          asset.assetId !== id ||
          (kind === "markdown"
            ? asset.media !== "text/markdown"
            : !asset.media.startsWith("image/"))
        )
          throw Error("Widget asset does not match this pane.");
        const document: WidgetDocument =
          kind === "markdown"
            ? {
                kind,
                text: new TextDecoder("utf-8", { fatal: true }).decode(
                  Uint8Array.from(atob(asset.data), (c) => c.charCodeAt(0)),
                ),
              }
            : { kind, src: `data:${asset.media};base64,${asset.data}`, name: asset.name };
        publish({ status: "ready", document });
      } catch {
        if (request === epoch) publish({ status: "error" });
      }
    },
  };
}
