/**
 * Complete deferred Files capability.
 *
 * The application shell imports this module only through the literal loader in
 * application-optional-features.ts. Its static dependencies therefore enter
 * the process together, after terminal readiness and explicit Files demand.
 */
import ignore, { type Ignore } from "ignore";

export { FilesSurface, type FilesSurfaceProps } from "../../files-surface-view.tsx";
export {
  filesHitTest,
  filesListWidth,
  projectFilesSurface,
  type FilesActionId,
  type FilesSurfaceProjection,
} from "../../files-surface.ts";
export {
  classifyFile,
  isBinary,
  readOnlyBanner,
  sanitizeForDisplay,
  type ReadOnlyReason,
} from "../../editor-buffer.ts";
export {
  shouldActivateFilesAfterEditorOpen,
  type EditorOpenOrigin,
} from "../../editor-open-policy.ts";
export {
  ALWAYS_IGNORE,
  ancestorDirs,
  buildNodes,
  changedFileWalk,
  filterEntries,
  filterView,
  indexOfPath,
  insertChildrenAt,
  nextChangedPath,
  rebuildTree,
  relPath,
  removeSubtreeAt,
  statusMapFromEntries,
  type FileNode,
  type RawEntry,
} from "../../file-tree.ts";

export type FilesIgnore = Ignore;
export const createFilesIgnore = (): Ignore => ignore();
export {
  createFilesFeatureSession,
  FilesFeatureSession,
  type FilesFeatureHost,
  type FilesFeatureIO,
} from "./session.ts";
