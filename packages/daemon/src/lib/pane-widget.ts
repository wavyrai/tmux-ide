import { basename, extname } from "node:path";

import {
  WIDGET_MARKER_MAX_PAYLOAD_CHARACTERS,
  widgetMarkerAnnouncement,
} from "@tmux-ide/contracts";

/**
 * `tmux-ide widget` — the helper that opts a pane into rich rendering.
 *
 * PURE. Everything here turns bytes the caller already read into the exact
 * string the pane should print; the CLI does the reading, the writing and the
 * signal handling. See apps/desktop-renderer/src/terminal/widgets/WIDGETS.md
 * for the grammar and the refusals.
 */

export type PaneWidgetRefusalReason =
  | "unsupported-media"
  | "too-large"
  | "empty"
  | "unknown-widget";

export class PaneWidgetRefusal extends Error {
  constructor(
    readonly reason: PaneWidgetRefusalReason,
    message: string,
  ) {
    super(message);
    this.name = "PaneWidgetRefusal";
  }
}

/** Extensions the image widget can render, mapped to the media type it declares. */
const IMAGE_MEDIA_BY_EXTENSION = new Map<string, string>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
]);

export function imageMediaTypeFor(fileName: string): string | null {
  return IMAGE_MEDIA_BY_EXTENSION.get(extname(fileName).toLowerCase()) ?? null;
}

/**
 * The largest file the image widget can carry.
 *
 * The bytes travel inside the marker line, so the ceiling is the marker's, less
 * the JSON envelope and the two encoding steps (base64 into the argument
 * object, then base64url over the whole object): 1.34 x 1.34 is a little over
 * 1.78, so a source file gets a little over half the budget. Serving image
 * bytes over a daemon route instead — which lifts this entirely — is the
 * documented follow-up.
 */
export const PANE_WIDGET_IMAGE_MAX_BYTES = Math.floor(
  (WIDGET_MARKER_MAX_PAYLOAD_CHARACTERS / 1.78) * 0.94,
);

export function buildMarkdownAnnouncement(text: string, title?: string): string {
  if (text.trim().length === 0) {
    throw new PaneWidgetRefusal("empty", "There is no markdown to render: the input was empty.");
  }
  try {
    return widgetMarkerAnnouncement("markdown", title === undefined ? { text } : { text, title });
  } catch {
    throw new PaneWidgetRefusal(
      "too-large",
      `The markdown is too large to render in a pane (the marker holds about ` +
        `${Math.floor(WIDGET_MARKER_MAX_PAYLOAD_CHARACTERS / 1_024)} KB of encoded arguments).`,
    );
  }
}

export function buildImageAnnouncement(bytes: Uint8Array, filePath: string): string {
  const name = basename(filePath);
  const media = imageMediaTypeFor(name);
  if (media === null) {
    throw new PaneWidgetRefusal(
      "unsupported-media",
      `"${name}" is not an image this pane can render. Supported: ` +
        `${[...IMAGE_MEDIA_BY_EXTENSION.keys()].join(", ")}. SVG is deliberately excluded — it is ` +
        `a document that can carry script, not a picture.`,
    );
  }
  if (bytes.byteLength === 0) {
    throw new PaneWidgetRefusal("empty", `"${name}" is empty.`);
  }
  if (bytes.byteLength > PANE_WIDGET_IMAGE_MAX_BYTES) {
    throw new PaneWidgetRefusal(
      "too-large",
      `"${name}" is ${Math.round(bytes.byteLength / 1_024)} KB, over the ` +
        `${Math.round(PANE_WIDGET_IMAGE_MAX_BYTES / 1_024)} KB limit for an in-pane image. The ` +
        `bytes travel inside the pane's own output, so the ceiling is the marker's.`,
    );
  }
  return widgetMarkerAnnouncement("image", {
    media,
    data: Buffer.from(bytes).toString("base64"),
    name,
  });
}

export const PANE_WIDGET_IDS = ["markdown", "image"] as const;
export type PaneWidgetId = (typeof PANE_WIDGET_IDS)[number];

export function paneWidgetId(value: string): PaneWidgetId {
  if ((PANE_WIDGET_IDS as readonly string[]).includes(value)) return value as PaneWidgetId;
  throw new PaneWidgetRefusal(
    "unknown-widget",
    `"${value}" is not a widget. Available: ${PANE_WIDGET_IDS.join(", ")}.`,
  );
}

/**
 * What the helper prints on SIGINT: erase the screen and park the cursor.
 *
 * Clearing is what actually restores the pane. The renderer keeps showing a
 * widget for exactly as long as the marker is somewhere in the grid, so wiping
 * the grid — not exiting, not any message to the app — is the signal that this
 * pane is an ordinary terminal again.
 */
export const PANE_WIDGET_RESTORE_SEQUENCE = "\u001b[2J\u001b[3J\u001b[H";
