import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { publishWidgetAsset } from "../lib/widget-asset-store.ts";
import { createApp } from "./server.ts";

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tmux-ide-widget-route-"));
  previousHome = process.env.TMUX_IDE_HOME;
  process.env.TMUX_IDE_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.TMUX_IDE_HOME;
  else process.env.TMUX_IDE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe("GET /api/widget-assets/:assetId", () => {
  it("serves only a published, content-addressed asset", async () => {
    const bytes = Buffer.from("# Plan\n", "utf8");
    const asset = publishWidgetAsset(bytes, { media: "text/markdown", name: "PLAN.md" });
    const response = await createApp().request(`/api/widget-assets/${asset.assetId}`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      assetId: asset.assetId,
      media: "text/markdown",
      name: "PLAN.md",
      data: bytes.toString("base64"),
    });
  });

  it("does not accept paths in place of asset capabilities", async () => {
    expect((await createApp().request("/api/widget-assets/..%2Fdaemon.json")).status).toBe(404);
  });
});
