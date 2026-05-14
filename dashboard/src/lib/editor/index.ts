/**
 * Public surface for the editor / per-filetype renderer subsystem.
 *
 * G17-P2 ships:
 *   - `getFileKind` / `isPreviewableKind` / `isBinaryForDiff` — pure
 *   - `getDefaultRenderer` — kind → renderer descriptor
 *   - `FileRenderer` — dispatching Solid component
 *   - `ManagedFile`, `ManagedFileKind`, `FileRendererKind`,
 *     `FileRendererData` — types
 *
 * The five concrete renderers (Binary / Image / Markdown / Svg /
 * TooLarge) live under `dashboard/src/components/editor/` — import
 * them directly when a host needs to bypass the dispatch.
 */

export {
  getFileKind,
  isPreviewableKind,
  isBinaryForDiff,
  RASTER_EXTS,
  BINARY_EXTS,
} from "./fileKind";
export { getDefaultRenderer } from "./renderer-utils";
export { FileRenderer } from "./dispatch";
export type { FileRendererProps } from "./dispatch";
export type { ManagedFile, ManagedFileKind, FileRendererData, FileRendererKind } from "./types";
