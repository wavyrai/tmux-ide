import type { OpenTuiGenerationHostSnapshot } from "./open-tui-generation-host.ts";

/** Separate mounted chrome readiness from explicit workspace input authority. */
export function createApplicationInputReadiness(
  chromeReady: Promise<void>,
  requireWorkspaceGeneration: boolean,
  resolve: () => void,
  reject: (error: unknown) => void,
) {
  let resolveWorkspace!: () => void;
  const workspaceReady = requireWorkspaceGeneration
    ? new Promise<void>((settle) => {
        resolveWorkspace = settle;
      })
    : Promise.resolve();
  if (!requireWorkspaceGeneration) resolveWorkspace = () => undefined;
  void Promise.all([chromeReady, workspaceReady]).then(() => resolve(), reject);
  return {
    adopt(snapshot: OpenTuiGenerationHostSnapshot | null): void {
      if (
        snapshot?.daemonGeneration &&
        snapshot.client &&
        (snapshot.status === "live" || snapshot.status === "empty")
      )
        resolveWorkspace();
    },
  };
}
