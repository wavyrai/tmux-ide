/** Native client has its own immutable host artifact and retained local managed owner. */
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { type DevelopmentComposeProject } from "./development-compose.ts";
import {
  developmentContainerClient,
  developmentContainerClientInfo,
  withReadyDevelopmentContainer,
} from "./development-container.ts";
import { buildDevelopmentInstance } from "./development-build-manager.ts";
import { readDevelopmentBuild } from "./development-build.ts";
import { launchDevelopmentApp, prepareDevelopmentAppRemote } from "./development-app.ts";
import { DevelopmentOperationError } from "./development-state.ts";
export async function launchDevelopmentContainerApp(
  project: DevelopmentComposeProject,
  options: { bun?: string; signal?: AbortSignal } = {},
) {
  const client = developmentContainerClient(project);
  let missing = false;
  try {
    lstatSync(join(client.root, "build.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    missing = true;
  }
  if (missing) {
    // First builds preflight the remote; warm launches perform one final locked probe only.
    await withReadyDevelopmentContainer(project, async () => {}, options.signal);
    if (!options.bun)
      throw new DevelopmentOperationError(
        "build-failed",
        "First container app requires --bun /absolute/pinned/bun for its separate native client build",
      );
    await buildDevelopmentInstance(client, {
      bun: options.bun,
      signal: options.signal,
      onlyIfSelectionAbsent: true,
    });
  } else readDevelopmentBuild(client, {});
  options.signal?.throwIfAborted();
  const admitted = await withReadyDevelopmentContainer(
    project,
    async (remote) => {
      const target = prepareDevelopmentAppRemote(remote);
      return launchDevelopmentApp(client, target);
    },
    options.signal,
  );
  return { ...admitted, nativeClient: developmentContainerClientInfo(project) };
}
