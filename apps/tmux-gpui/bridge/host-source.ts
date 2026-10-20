import { z } from "zod";
import { SavedMachineSchema } from "../../../packages/contracts/src/index.ts";
import { createDaemonConnectionOwner } from "../../../packages/daemon/src/lib/daemon-connection-owner.ts";
import { discoverPreviewHost } from "./discovery.ts";
import { hostSchema, readPrivateConfig, type PreviewHost } from "./config.ts";
import {
  createRemotePreviewRoute,
  RemoteRouteError,
  type RemotePreviewRoute,
} from "./remote-route.ts";

export const remoteHostConfigSchema = z
  .object({
    sshTarget: SavedMachineSchema.shape.sshTarget,
    expectedEnvironmentId: SavedMachineSchema.shape.expectedEnvironmentId,
    scope: hostSchema.shape.scope.optional(),
  })
  .strict();
const defaults = {
  createOwner: createDaemonConnectionOwner,
  discover: discoverPreviewHost,
  readConfig: readPrivateConfig,
  route: createRemotePreviewRoute,
};

/** Own the transport outside catalog/pane navigation; never expose tokens in publications. */
export function createPreviewHostSource(
  argument: string,
  onRetired: () => void,
  dependencies = defaults,
) {
  let stopped = false;
  let revision = 0;
  let remote: { key: string; owner: ReturnType<typeof createDaemonConnectionOwner> } | null = null;
  let route: RemotePreviewRoute | null = null;
  let removeAbort = () => {};
  const lifetime = new AbortController();
  let selection: z.infer<typeof remoteHostConfigSchema> | null | undefined;
  const clearRoute = () => {
    removeAbort();
    removeAbort = () => {};
    route?.dispose();
    route = null;
  };
  const clearRemote = () => {
    clearRoute();
    remote?.owner.dispose();
    remote = null;
  };
  return {
    isLocal: () => selection === null || (selection === undefined && argument === "--local"),
    select(sshTarget: string | null, expectedEnvironmentId?: string) {
      const next =
        sshTarget === null
          ? null
          : remoteHostConfigSchema.parse({ sshTarget, expectedEnvironmentId });
      revision++;
      clearRemote();
      selection = next;
    },
    async read(): Promise<PreviewHost> {
      if (stopped) throw new RemoteRouteError("retired");
      const token = ++revision;
      const current = () => !stopped && token === revision;
      clearRoute();
      if (selection === null || (selection === undefined && argument === "--local")) {
        clearRemote();
        const host = await dependencies.discover();
        if (!current()) throw new RemoteRouteError("retired");
        return host;
      }
      const config = selection ?? dependencies.readConfig(argument);
      const target = remoteHostConfigSchema.safeParse(config);
      if (!target.success) {
        clearRemote();
        return hostSchema.parse(config);
      }
      const key = JSON.stringify({
        sshTarget: target.data.sshTarget,
        expectedEnvironmentId: target.data.expectedEnvironmentId,
      });
      if (remote?.key !== key || remote.owner.endpoint().state !== "ready") {
        clearRemote();
        const owner = dependencies.createOwner();
        remote = { key, owner };
        try {
          await owner.initialize(target.data.sshTarget, lifetime.signal, {
            expectedEnvironmentId: target.data.expectedEnvironmentId,
          });
        } catch {
          if (remote?.owner === owner) clearRemote();
          else owner.dispose();
          throw new RemoteRouteError("unavailable");
        }
      }
      if (!current()) throw new RemoteRouteError("retired");
      const selected = remote!;
      const next = await dependencies.route(selected.owner, {
        signal: lifetime.signal,
        scope: target.data.scope,
      });
      if (!current() || remote !== selected) {
        next.dispose();
        throw new RemoteRouteError("retired");
      }
      route = next;
      const retired = () => {
        if (route !== next || stopped) return;
        clearRoute();
        onRetired();
      };
      next.signal.addEventListener("abort", retired, { once: true });
      removeAbort = () => next.signal.removeEventListener("abort", retired);
      if (next.signal.aborted) {
        retired();
        throw new RemoteRouteError("retired");
      }
      return next.host;
    },
    dispose() {
      if (stopped) return;
      stopped = true;
      revision++;
      clearRemote();
      lifetime.abort();
    },
  };
}
