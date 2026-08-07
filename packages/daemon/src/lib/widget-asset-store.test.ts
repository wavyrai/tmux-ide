import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  WIDGET_ASSET_MAX_BYTES,
  WidgetAssetStoreError,
  publishWidgetAsset,
  readWidgetAsset,
} from "./widget-asset-store.ts";

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tmux-ide-widget-assets-"));
  previousHome = process.env.TMUX_IDE_HOME;
  process.env.TMUX_IDE_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.TMUX_IDE_HOME;
  else process.env.TMUX_IDE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe("widget asset store", () => {
  it("publishes and verifies a content-addressed raster asset", () => {
    const bytes = Buffer.from("GIF89a", "ascii");
    const published = publishWidgetAsset(bytes, { media: "image/gif", name: "demo.gif" });
    expect(published.assetId).toMatch(/^[0-9a-f]{64}$/u);
    expect(readWidgetAsset(published.assetId)).toMatchObject({
      media: "image/gif",
      name: "demo.gif",
      byteLength: bytes.length,
    });
    expect(readWidgetAsset(published.assetId)?.bytes).toEqual(bytes);
  });

  it("refuses unsafe media, empty content, oversized content, and malformed ids", () => {
    expect(() =>
      publishWidgetAsset(new Uint8Array([1]), { media: "image/svg+xml" as never, name: "x.svg" }),
    ).toThrow(WidgetAssetStoreError);
    expect(() =>
      publishWidgetAsset(new Uint8Array(), { media: "image/png", name: "empty.png" }),
    ).toThrow(/empty/u);
    expect(() =>
      publishWidgetAsset(new Uint8Array(WIDGET_ASSET_MAX_BYTES + 1), {
        media: "image/png",
        name: "huge.png",
      }),
    ).toThrow(/limit/u);
    expect(readWidgetAsset("../../daemon.json")).toBe(null);
  });
});
