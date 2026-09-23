import {
  WorkspaceSessionCreateArgumentsSchemaZ,
  type WorkspaceSessionCreateArguments,
  type WorkspaceSessionCreateResult,
} from "@tmux-ide/contracts";
import { FleetLifecycleAuthority } from "./fleet-lifecycle-authority.ts";
import type { WorkspaceRegistry } from "./workspace-registry.ts";

/** Bounded online-server creation. The existing lifecycle owns idempotency and workspace naming. */
export function createNativeTmuxSessionCreator(options: {
  generation: string;
  registry: WorkspaceRegistry;
  run(args: readonly string[]): string;
  assertOpen(): void;
}) {
  let disposed = false;
  const pending = new Set<Promise<WorkspaceSessionCreateResult>>();
  const assertOpen = () => {
    options.assertOpen();
    if (disposed) throw new Error("Session creation is retired");
  };
  const authority = new FleetLifecycleAuthority({
    daemonInstanceId: options.generation,
    productVersion: "scoped-owner",
    startedAt: new Date().toISOString(),
    registry: options.registry,
    runTmux(args) {
      assertOpen();
      return options.run(args);
    },
    readFleet: () => [],
    ensureChromeUpdater: false,
  });
  return {
    createSession(operationId: string, input: WorkspaceSessionCreateArguments) {
      assertOpen();
      const parsed = WorkspaceSessionCreateArgumentsSchemaZ.parse(input);
      if (parsed.expectedDaemonInstanceId && parsed.expectedDaemonInstanceId !== options.generation)
        throw new Error("Selected tmux server generation changed");
      if (pending.size >= 16) throw new Error("Session creation capacity reached");
      const operation = authority
        .createSession(operationId, options.generation, parsed)
        .finally(() => pending.delete(operation));
      pending.add(operation);
      return operation;
    },
    async dispose() {
      disposed = true;
      await Promise.allSettled([...pending]);
    },
  };
}
