/**
 * Map a detected `ManagedFileKind` to its default renderer kind.
 *
 * Mirrors emdash's `renderer-utils.ts`: markdown defaults to the
 * preview pane, svg defaults to the rendered image, everything else
 * passes through unchanged. G17-P4 will wire the source-toggle UI
 * that flips markdown / svg into their `*-source` modes.
 */

import type { FileRendererData, ManagedFileKind } from "./types";

export function getDefaultRenderer(
  kind: Exclude<ManagedFileKind, "too-large"> | ManagedFileKind,
): FileRendererData {
  switch (kind) {
    case "markdown":
      return { kind: "markdown" };
    case "svg":
      return { kind: "svg" };
    default:
      return { kind } as FileRendererData;
  }
}
