import type { ApplicationShellProjectionInputV1 } from "@tmux-ide/contracts";
import type { WebWorkspaceClient } from "../../../desktop-renderer/src/runtime/web-workspace-client";
import type { WorkspacePaneCompositor } from "../../../desktop-renderer/src/terminal/workspace-pane-compositor";
export interface WorkspaceRuntime {
  client: WebWorkspaceClient;
  compositor: WorkspacePaneCompositor;
  shell: ApplicationShellProjectionInputV1;
}
