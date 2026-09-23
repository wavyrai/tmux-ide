import { randomUUID } from "node:crypto";
import { WorkspaceCatalogLiveSessionIdSchemaZ } from "@tmux-ide/contracts";
import { liveSessionIdForNativeIdentity } from "../terminal/protocol/live-session-identity.ts";
import { fleetSessionIdForName } from "../command-center/resources/fleet-catalog.ts";
import { isVisibleFleetSession } from "../command-center/discovery.ts";
import { WorkspacePromotionAuthority } from "./workspace-promotion.ts";
import type { WorkspaceRegistry } from "./workspace-registry.ts";
import { shellEscape } from "./shell.ts";

/** Owner-local bounded admission; all native IO must already fence the server generation. */
export function createNativeTmuxSessionOpener(options: {
  generation: string;
  registry: WorkspaceRegistry;
  run(args: readonly string[]): Promise<string>;
  assertOpen(): void;
}) {
  let disposed = false;
  let tail: Promise<unknown> = Promise.resolve();
  const pending = new Map<string, Promise<{ workspaceName: string; liveSessionId: string }>>();
  const assertOpen = () => {
    options.assertOpen();
    if (disposed) throw new Error("Session admission is retired");
  };
  const open = async (liveSessionId: string) => {
    assertOpen();
    const records = await options.run([
      "list-sessions",
      "-F",
      "#{pid}\t#{session_id}\t#{session_created}\t#{session_name}",
    ]);
    const matches = records
      .trim()
      .split("\n")
      .map((line) => line.split("\t"))
      .filter(
        ([pid, id, created, name]) =>
          pid &&
          /^\d+$/.test(pid) &&
          id &&
          /^\$\d+$/.test(id) &&
          created &&
          /^\d+$/.test(created) &&
          name &&
          isVisibleFleetSession(name) &&
          liveSessionIdForNativeIdentity(pid, id, created) === liveSessionId,
      );
    if (matches.length !== 1) throw new Error("Selected live tmux session is no longer available");
    const [, nativeSessionId, created, name] = matches[0]!;
    // Each command checks the exact native session on the server accepting it.
    // A name-only validation followed by stamping would cross a session replacement.
    const run = async (args: readonly string[]) => {
      assertOpen();
      const sentinel = `tmux-session-stale.${randomUUID()}`;
      const condition = `#{&&:#{==:#{session_id},${nativeSessionId}},#{==:#{session_created},${created}}}`;
      const command = args.map((arg) => (arg === ";" ? ";" : shellEscape(arg))).join(" ");
      const output = await options.run([
        "if-shell",
        "-t",
        nativeSessionId!,
        "-F",
        condition,
        command,
        `display-message -p '${sentinel}'`,
      ]);
      assertOpen();
      if (output.trim() === sentinel)
        throw new Error("Selected live tmux session changed during admission");
      return output;
    };
    const promotion = new WorkspacePromotionAuthority({
      daemonInstanceId: options.generation,
      registry: options.registry,
      io: { runTmux: run },
    });
    try {
      const result = await promotion.promote({
        operationId: randomUUID(),
        expectedDaemonInstanceId: options.generation,
        intent: { sessionId: fleetSessionIdForName(name!) },
      });
      await run(["display-message", "-p", "-t", nativeSessionId!, "#{session_id}"]);
      return { workspaceName: result.resource.workspaceName, liveSessionId };
    } finally {
      await promotion.dispose();
    }
  };
  return {
    openSession(liveSessionId: string) {
      WorkspaceCatalogLiveSessionIdSchemaZ.parse(liveSessionId);
      assertOpen();
      const previous = pending.get(liveSessionId);
      if (previous) return previous;
      if (pending.size >= 16) throw new Error("Session admission capacity reached");
      const operation = tail
        .then(() => open(liveSessionId))
        .finally(() => pending.delete(liveSessionId));
      pending.set(liveSessionId, operation);
      tail = operation.catch(() => {});
      return operation;
    },
    async dispose() {
      disposed = true;
      await tail;
    },
  };
}
