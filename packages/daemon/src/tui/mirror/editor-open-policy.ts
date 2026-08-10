import type { HostedPanelKind } from "./panel-host.ts";

export type EditorOpenOrigin = "user" | "workspace-hydration";

/**
 * Opening a file because the user asked should reveal Files. Restoring a
 * persisted editor buffer must remain navigation-neutral: the dock may be
 * collapsed while Terminals keeps focus, and forcing Files here recursively
 * re-enters workspace hydration.
 */
export function shouldActivateFilesAfterEditorOpen(
  activePanel: HostedPanelKind,
  origin: EditorOpenOrigin,
): boolean {
  return origin === "user" && activePanel !== "files";
}
