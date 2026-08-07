import { describe, expect, it } from "vitest";
import {
  WIDGET_MARKER_CONCEAL_PREFIX,
  WIDGET_MARKER_CONCEAL_SUFFIX,
  decodeWidgetMarkerLine,
} from "@tmux-ide/contracts";

import {
  PANE_WIDGET_IMAGE_MAX_BYTES,
  PANE_WIDGET_RESTORE_SEQUENCE,
  PaneWidgetRefusal,
  buildImageAnnouncement,
  buildImageAssetAnnouncement,
  buildMarkdownAssetAnnouncement,
  buildCardAnnouncement,
  buildMarkdownAnnouncement,
  imageMediaTypeFor,
  paneWidgetId,
} from "./pane-widget.ts";

/** The marker as the emulator would hold it: conceal codes stripped, no newline. */
function markerLine(announcement: string): string {
  return announcement
    .replaceAll(WIDGET_MARKER_CONCEAL_PREFIX, "")
    .replaceAll(WIDGET_MARKER_CONCEAL_SUFFIX, "")
    .trimEnd();
}

describe("the markdown helper", () => {
  it("emits a marker the renderer's own decoder accepts", () => {
    const announcement = buildMarkdownAnnouncement("# Plan\n\n- one\n- two");
    expect(decodeWidgetMarkerLine(markerLine(announcement))).toEqual({
      id: "markdown",
      args: { text: "# Plan\n\n- one\n- two" },
    });
  });

  it("emits exactly one line, so the pane's own output cannot split it", () => {
    const announcement = buildMarkdownAnnouncement("a\nb\nc");
    expect(announcement.split("\n").filter((line) => line.length > 0)).toHaveLength(1);
    expect(announcement.endsWith("\n")).toBe(true);
  });

  it("carries a title when one is given", () => {
    const decoded = decodeWidgetMarkerLine(markerLine(buildMarkdownAnnouncement("x", "Plan")));
    expect(decoded?.args).toEqual({ text: "x", title: "Plan" });
  });

  it("refuses empty input rather than rendering a blank surface", () => {
    expect(() => buildMarkdownAnnouncement("   \n  ")).toThrow(PaneWidgetRefusal);
  });

  it("refuses a document over the marker ceiling, naming the limit", () => {
    try {
      buildMarkdownAnnouncement("x".repeat(200_000));
      expect.unreachable("an oversized document must be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(PaneWidgetRefusal);
      expect((error as PaneWidgetRefusal).reason).toBe("too-large");
      expect((error as PaneWidgetRefusal).message).toMatch(/KB/u);
    }
  });
});

describe("the image helper", () => {
  // A one-pixel GIF: real bytes, and small enough to be a fixture rather than a file.
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");

  it("maps the extensions it supports and refuses the ones it does not", () => {
    expect(imageMediaTypeFor("a.GIF")).toBe("image/gif");
    expect(imageMediaTypeFor("a.jpeg")).toBe("image/jpeg");
    expect(imageMediaTypeFor("a.svg")).toBe(null);
    expect(imageMediaTypeFor("a.txt")).toBe(null);
  });

  it("emits a decodable marker carrying the file's bytes and name", () => {
    const decoded = decodeWidgetMarkerLine(markerLine(buildImageAnnouncement(gif, "art/spin.gif")));
    expect(decoded?.id).toBe("image");
    expect(decoded?.args).toEqual({
      media: "image/gif",
      data: gif.toString("base64"),
      name: "spin.gif",
    });
  });

  /*
   * Bug this catches: an SVG rendered as a picture. It is a document that can
   * carry script and external references, so the helper must not be the thing
   * that hands one to the renderer — the registry refuses it too, but a refusal
   * the user reads at the command line is the one that explains itself.
   */
  it("refuses SVG by name and says why", () => {
    try {
      buildImageAnnouncement(gif, "diagram.svg");
      expect.unreachable("SVG must be refused");
    } catch (error) {
      expect((error as PaneWidgetRefusal).reason).toBe("unsupported-media");
      expect((error as PaneWidgetRefusal).message).toMatch(/script/u);
    }
  });

  it("refuses a file over the in-pane ceiling, naming both sizes", () => {
    const oversized = Buffer.alloc(PANE_WIDGET_IMAGE_MAX_BYTES + 1, 1);
    try {
      buildImageAnnouncement(oversized, "big.png");
      expect.unreachable("an oversized image must be refused");
    } catch (error) {
      expect((error as PaneWidgetRefusal).reason).toBe("too-large");
      expect((error as PaneWidgetRefusal).message).toMatch(/KB, over the .* KB limit/u);
    }
  });

  /*
   * The ceiling has to be one the marker actually accepts. Bug this catches: a
   * limit derived from the wrong encoding overhead, so a file the helper says
   * is fine is then rejected by the grammar and the pane renders nothing.
   */
  it("accepts a file at exactly the ceiling", () => {
    const atLimit = Buffer.alloc(PANE_WIDGET_IMAGE_MAX_BYTES, 7);
    expect(decodeWidgetMarkerLine(markerLine(buildImageAnnouncement(atLimit, "big.png")))?.id).toBe(
      "image",
    );
  });

  it("refuses an empty file", () => {
    expect(() => buildImageAnnouncement(Buffer.alloc(0), "empty.png")).toThrow(PaneWidgetRefusal);
  });
});

describe("the helper's surface", () => {
  it("accepts only the widgets that exist", () => {
    expect(paneWidgetId("markdown")).toBe("markdown");
    expect(paneWidgetId("image")).toBe("image");
    expect(paneWidgetId("card")).toBe("card");
    expect(() => paneWidgetId("mermaid")).toThrow(/Available: markdown, image, card/u);
  });

  it("emits compact asset references and validated declarative cards", () => {
    const assetId = "a".repeat(64);
    expect(
      decodeWidgetMarkerLine(markerLine(buildMarkdownAssetAnnouncement(assetId, "PLAN.md")))?.args,
    ).toEqual({ assetId, title: "PLAN.md" });
    expect(
      decodeWidgetMarkerLine(markerLine(buildImageAssetAnnouncement(assetId, { name: "demo.gif" })))
        ?.args,
    ).toEqual({ assetId, name: "demo.gif" });
    expect(
      decodeWidgetMarkerLine(
        markerLine(
          buildCardAnnouncement({ title: "Build", items: [{ type: "progress", value: 72 }] }),
        ),
      )?.id,
    ).toBe("card");
    expect(() => buildCardAnnouncement({ title: "Build", items: [{ type: "script" }] })).toThrow();
  });

  /*
   * Ctrl-C restores the pane by CLEARING it, including the scrollback (ED 3):
   * the renderer shows a widget for as long as the marker is anywhere in the
   * grid, so an erase that spared the scrollback would leave the marker up
   * there and the widget on screen.
   */
  it("restores by erasing the screen and its scrollback", () => {
    expect(PANE_WIDGET_RESTORE_SEQUENCE).toContain("[2J");
    expect(PANE_WIDGET_RESTORE_SEQUENCE).toContain("[3J");
  });
});
