import { describe, expect, it } from "vitest";

import { imageWidgetDataUrl, resolveWidget, widgetDefinition } from "./widget-registry.ts";
import type { WidgetMarker } from "@tmux-ide/contracts";

function marker(id: string, args: unknown): WidgetMarker {
  return { id, args, lineIndex: 0 };
}

describe("the widget registry", () => {
  it("ships exactly the widgets this build claims", () => {
    expect(widgetDefinition("markdown")?.label).toBe("Markdown");
    expect(widgetDefinition("image")?.label).toBe("Image");
    expect(widgetDefinition("card")?.label).toBe("Card");
    expect(widgetDefinition("mermaid")).toBe(null);
  });

  it("accepts content-addressed assets without accepting arbitrary paths or URLs", () => {
    const assetId = "a".repeat(64);
    expect(resolveWidget(marker("markdown", { assetId })).status).toBe("ready");
    expect(resolveWidget(marker("image", { assetId, name: "demo.gif" })).status).toBe("ready");
    for (const invalid of ["/tmp/demo.gif", "https://example.com/demo.gif", "../secret"]) {
      expect(resolveWidget(marker("image", { assetId: invalid })).status).toBe("invalid-arguments");
    }
  });

  it("validates the declarative card vocabulary", () => {
    expect(
      resolveWidget(
        marker("card", {
          title: "Build",
          items: [
            { type: "badge", text: "Passed", tone: "success" },
            { type: "progress", value: 72 },
            { type: "button", label: "Rerun", input: "pnpm test" },
          ],
        }),
      ).status,
    ).toBe("ready");
    expect(
      resolveWidget(
        marker("card", { title: "Unsafe", items: [{ type: "html", html: "<b>x</b>" }] }),
      ).status,
    ).toBe("invalid-arguments");
  });

  it("resolves a valid markdown marker", () => {
    const resolution = resolveWidget(marker("markdown", { text: "# Hi" }));
    expect(resolution).toMatchObject({ status: "ready", args: { text: "# Hi" } });
  });

  /*
   * Bug this catches: an unrecognised id and malformed arguments collapse into
   * one "it didn't work" state, and a user whose build is simply older cannot
   * tell that from a helper that emitted nonsense.
   */
  it("tells an unknown widget apart from bad arguments", () => {
    expect(resolveWidget(marker("mermaid", {}))).toEqual({
      status: "unknown-widget",
      id: "mermaid",
    });
    expect(resolveWidget(marker("markdown", { text: 42 }))).toMatchObject({
      status: "invalid-arguments",
      id: "markdown",
    });
  });

  it("refuses arguments the widget did not ask for", () => {
    // Strict schemas: a marker cannot smuggle a field past the trust boundary.
    expect(resolveWidget(marker("markdown", { text: "x", onLoad: "boom" }))).toMatchObject({
      status: "invalid-arguments",
    });
  });

  it("refuses a marker whose arguments are not an object at all", () => {
    for (const args of [null, "text", 7, ["a"]]) {
      expect(resolveWidget(marker("markdown", args)).status).toBe("invalid-arguments");
    }
  });
});

describe("the image widget's media boundary", () => {
  const gif = { media: "image/gif", data: "R0lGODlhAQABAAAAACw=", name: "spin.gif" };

  it("accepts raster media and builds a data URL from validated parts only", () => {
    const resolution = resolveWidget(marker("image", gif));
    expect(resolution.status).toBe("ready");
    expect(imageWidgetDataUrl(gif as never)).toBe("data:image/gif;base64,R0lGODlhAQABAAAAACw=");
  });

  /*
   * Bug this catches: an SVG is a DOCUMENT, not a picture — it can carry script
   * and external references. Accepting one would turn "render the file this
   * pane named" into "execute the file this pane named".
   */
  it("refuses SVG and every other non-raster media type", () => {
    for (const media of ["image/svg+xml", "text/html", "application/pdf", "image/gif "]) {
      expect(resolveWidget(marker("image", { ...gif, media })).status, media).toBe(
        "invalid-arguments",
      );
    }
  });

  it("refuses a payload that is not base64, so nothing else can ride in the URL", () => {
    for (const data of ['");alert(1)//', "R0lGODlh AQABAAAA", "data:text/html,<script>"]) {
      expect(resolveWidget(marker("image", { ...gif, data })).status, data).toBe(
        "invalid-arguments",
      );
    }
  });
});
