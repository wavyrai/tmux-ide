import { z } from "zod";
import { TerminalAttachmentSemanticPaneIdSchemaZ } from "@tmux-ide/contracts";
import {
  agentIdForPaneStamp,
  fallbackPaneId,
} from "../command-center/resources/application-shell.ts";

export const observedAgentSchema = z
  .object({
    observedPaneId: z.string().min(1).max(512),
    observedAgentId: z.string().min(1).max(512),
  })
  .strict();
export type ObservedAgent = z.infer<typeof observedAgentSchema>;
type Binding = { pane: string; birth: string; window: string; stamp: string };

/** Fresh daemon facts only. No label/index fallback and no client-supplied native IDs. */
export async function captureAgentAdmission(
  run: (args: readonly string[]) => Promise<string>,
  session: { id: string; name: string },
  observed: ObservedAgent,
) {
  const scan = async (): Promise<Binding[]> => {
    const raw = await run([
      "list-panes",
      "-s",
      "-t",
      session.id,
      "-F",
      "#{session_id}\t#{window_id}\t#{pane_id}\t#{pane_birth_id}\t#{@tmux_ide_pane_id}",
    ]);
    if (Buffer.byteLength(raw) > 1024 * 1024)
      throw new Error("Agent inventory exceeds admission bounds");
    const rows = raw
      .replace(/\n+$/u, "")
      .split("\n")
      .map((line) => {
        const fields = line.split("\t");
        const [id, window, pane, birth, stamp] = fields;
        if (
          fields.length !== 5 ||
          id !== session.id ||
          !/^@\d+$/.test(window!) ||
          !/^%\d+$/.test(pane!) ||
          !/^(?:[1-9]\d*)?$/.test(birth!)
        )
          throw new Error("Agent native identity is unavailable");
        return { window: window!, pane: pane!, birth: birth!, stamp: stamp! };
      });
    if (rows.length > 512) throw new Error("Agent inventory exceeds admission bounds");
    // A stock tmux server has no pane birth id: every row reads empty. Its pane
    // ids are never reused while it runs, and each command already checks the
    // session id and creation time, so the pane and window ids fence the lifetime.
    if (rows.some((row) => row.birth === "") && rows.some((row) => row.birth !== ""))
      throw new Error("Agent native identity is unavailable");
    return rows;
  };
  const initial = await scan();
  const candidates = initial.filter((row) => {
    const id =
      row.stamp === ""
        ? fallbackPaneId(
            { name: session.name, runtimeSessionId: session.id },
            { runtimePaneId: row.pane },
          )
        : row.stamp;
    return id === observed.observedPaneId && agentIdForPaneStamp(id) === observed.observedAgentId;
  });
  if (candidates.length !== 1) throw new Error("Observed agent is no longer unique");
  const captured = candidates[0]!;
  if (
    captured.stamp &&
    (!TerminalAttachmentSemanticPaneIdSchemaZ.safeParse(captured.stamp).success ||
      initial.filter((r) => r.stamp === captured.stamp).length !== 1)
  )
    throw new Error("Observed agent stamp is ambiguous");
  return {
    async verify(promoted: boolean) {
      const rows = await scan();
      const matching = rows.filter((row) => row.pane === captured.pane);
      if (
        matching.length !== 1 ||
        matching[0]!.birth !== captured.birth ||
        matching[0]!.window !== captured.window
      )
        throw new Error("Observed agent lifetime changed");
      const current = matching[0]!;
      if (captured.stamp && current.stamp !== captured.stamp)
        throw new Error("Observed agent stamp changed");
      if (!promoted && current.stamp !== captured.stamp)
        throw new Error("Observed agent stamp changed");
      if (
        promoted &&
        (!TerminalAttachmentSemanticPaneIdSchemaZ.safeParse(current.stamp).success ||
          rows.filter((row) => row.stamp === current.stamp).length !== 1)
      )
        throw new Error("Promoted agent identity is unavailable");
      return current.stamp;
    },
  };
}
