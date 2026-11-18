import {
  captureAgentAdmission,
  observedAgentSchema,
  type ObservedAgent,
} from "./tmux-server-agent-admission.ts";
import { randomUUID } from "node:crypto";
import { WorkspaceCatalogLiveSessionIdSchemaZ } from "@tmux-ide/contracts";
import { liveSessionIdForNativeIdentity } from "../terminal/protocol/live-session-identity.ts";
import { fleetSessionIdForName } from "../command-center/resources/fleet-catalog.ts";
import { isVisibleFleetSession } from "../command-center/discovery.ts";
import {
  ADOPTED_OPTION,
  hasValidPaneStamp,
  SEMANTIC_PANE_OPTION,
  SEMANTIC_WINDOW_OPTION,
  WorkspacePromotionAuthority,
} from "./workspace-promotion.ts";
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
  const open = async (liveSessionId: string, observed?: ObservedAgent) => {
    assertOpen();
    // One row per pane: the session's identity, whether it is adopted, and
    // each window's and pane's stamp. tmux rejects tabs in session names, so
    // the name is the last field; a pane stamp with a tab is invalid anyway.
    const records = await options.run([
      "list-panes",
      "-a",
      "-F",
      `#{pid}\t#{session_id}\t#{session_created}\t#{${ADOPTED_OPTION}}\t#{${SEMANTIC_WINDOW_OPTION}}\t#{${SEMANTIC_PANE_OPTION}}\t#{session_name}`,
    ]);
    const rows = records
      .replace(/\n+$/u, "")
      .split("\n")
      .map((line) => line.split("\t"))
      .filter((fields) => fields.length >= 7)
      .map((fields) => ({
        pid: fields[0]!,
        id: fields[1]!,
        created: fields[2]!,
        adopted: fields[3]!,
        window: fields.slice(4, -2).join("\t"),
        pane: fields.at(-2)!,
        name: fields.at(-1)!,
      }))
      .filter(
        ({ pid, id, created, name }) =>
          /^\d+$/.test(pid) &&
          /^\$\d+$/.test(id) &&
          /^\d+$/.test(created) &&
          name &&
          isVisibleFleetSession(name) &&
          liveSessionIdForNativeIdentity(pid, id, created) === liveSessionId,
      );
    if (new Set(rows.map((row) => row.id)).size !== 1)
      throw new Error("Selected live tmux session is no longer available");
    const { id: nativeSessionId, created, name } = rows[0]!;
    // Re-opening a session that an earlier open already finished changes
    // nothing: it is adopted, has exactly one durable alias, and every window
    // and pane already carries a stamp. Promotion would only read it again
    // (seven tmux commands), so skip it. Anything else promotes as before,
    // which also stamps panes split since the last open.
    const aliases = options.registry.list().filter((entry) => entry.sessionName === name);
    if (
      !observed &&
      aliases.length === 1 &&
      !options.registry.isVolatile(aliases[0]!.name) &&
      rows.every(
        (row) => row.adopted === "1" && row.window.length > 0 && hasValidPaneStamp(row.pane),
      )
    ) {
      assertOpen();
      return { workspaceName: aliases[0]!.name, liveSessionId };
    }
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
        nativeSessionId,
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
    const agent = observed
      ? await captureAgentAdmission(run, { id: nativeSessionId, name }, observed)
      : null;
    await agent?.verify(false);
    const promotion = new WorkspacePromotionAuthority({
      daemonInstanceId: options.generation,
      registry: options.registry,
      io: { runTmux: run },
    });
    try {
      const result = await promotion.promote({
        operationId: randomUUID(),
        expectedDaemonInstanceId: options.generation,
        intent: { sessionId: fleetSessionIdForName(name) },
      });
      await run(["display-message", "-p", "-t", nativeSessionId, "#{session_id}"]);
      const semanticPaneId = await agent?.verify(true);
      return {
        workspaceName: result.resource.workspaceName,
        liveSessionId,
        ...(semanticPaneId ? { semanticPaneId } : {}),
      };
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
    openAgent(
      liveSessionId: string,
      input: ObservedAgent,
    ): Promise<{ workspaceName: string; liveSessionId: string; semanticPaneId: string }> {
      WorkspaceCatalogLiveSessionIdSchemaZ.parse(liveSessionId);
      const observed = observedAgentSchema.parse(input);
      assertOpen();
      if (pending.size >= 16) throw new Error("Session admission capacity reached");
      const key = randomUUID();
      const operation = tail
        .then(async () => {
          const result = await open(liveSessionId, observed);
          if (!result.semanticPaneId) throw new Error("Agent admission returned no target");
          return { ...result, semanticPaneId: result.semanticPaneId };
        })
        .finally(() => pending.delete(key));
      pending.set(key, operation);
      tail = operation.catch(() => {});
      return operation;
    },
    async dispose() {
      disposed = true;
      await tail;
    },
  };
}
