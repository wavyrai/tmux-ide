import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { WorkspaceCatalogLiveSessionIdSchemaZ } from "@tmux-ide/contracts";
import { liveSessionIdForNativeIdentity } from "../terminal/protocol/live-session-identity.ts";
import { shellEscape } from "./shell.ts";

/** Session identity travels with the mutation lane, never in global mutable selection. */
export function createTmuxSessionMutationFence() {
  const context = new AsyncLocalStorage<{ id: string; created: string; name: string }>();
  return {
    wrap(run: (args: readonly string[]) => string) {
      return (args: readonly string[]) => {
        const selected = context.getStore();
        if (!selected) return run(args);
        const sentinel = `tmux-session-stale.${randomUUID()}`;
        const output = run([
          "if-shell",
          "-t",
          `=${selected.name}`,
          "-F",
          `#{&&:#{==:#{session_id},${selected.id}},#{==:#{session_created},${selected.created}}}`,
          args.map((arg) => (arg === ";" ? ";" : shellEscape(arg))).join(" "),
          `display-message -p '${sentinel}'`,
        ]);
        if (output.trim() === sentinel)
          throw new Error("Selected live tmux session changed before mutation");
        return output;
      };
    },
    async execute<T>(options: {
      liveSessionId: string;
      sessionName: string;
      run(args: readonly string[]): Promise<string>;
      mutate(): Promise<T>;
    }): Promise<T> {
      WorkspaceCatalogLiveSessionIdSchemaZ.parse(options.liveSessionId);
      const raw = await options.run([
        "list-sessions",
        "-F",
        "#{pid}\t#{session_id}\t#{session_created}\t#{session_name}",
      ]);
      const rows = raw
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
            name === options.sessionName &&
            liveSessionIdForNativeIdentity(pid, id, created) === options.liveSessionId,
        );
      if (rows.length !== 1) throw new Error("Selected live tmux session is no longer available");
      const [, id, created] = rows[0]!;
      return context.run({ id: id!, created: created!, name: options.sessionName }, options.mutate);
    },
  };
}
