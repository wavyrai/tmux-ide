import { z } from "zod";
import {
  homeAgentStatusLabel,
  type HomeAgentRow,
  type HomeAgentSnapshot,
} from "../../../packages/presentation/src/home-agent-roster.ts";
export const openAgentSchema = z
  .object({
    type: z.literal("open-agent"),
    request: z.number().int().positive().safe(),
    fromRequest: z.number().int().nonnegative().safe(),
    rosterRevision: z.number().int().positive().safe(),
    key: z.string().min(1).max(512),
  })
  .strict();
export const openWorkspaceAgentSchema = openAgentSchema.extend({
  type: z.literal("open-workspace-agent"),
  sessionId: z.string().min(1).max(512),
});
const id = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512;
const display = (value: string, max: number) =>
  Array.from(value)
    .filter((character) => {
      const code = character.codePointAt(0)!;
      return code >= 32 && (code < 127 || code > 159);
    })
    .slice(0, max)
    .join("");
export function agentAvailable(row: HomeAgentRow) {
  return id(row.paneId) && !!(row.nativeIdentity || row.interactionEndpoint) && !row.disabled;
}
export function homeAgentPublication(snapshot: HomeAgentSnapshot, revision: number) {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Invalid roster revision");
  const rows = snapshot.rows
    .filter(
      (row) => id(row.key) && id(row.liveSessionId) && (row.paneId === null || id(row.paneId)),
    )
    .slice(0, 256)
    .map((row) => ({
      key: row.key,
      sessionId: row.liveSessionId,
      paneId: row.paneId,
      name: display(row.name, 160),
      sessionLabel: display(row.sessionName, 160),
      status: homeAgentStatusLabel(row.activity),
      attention: row.attention,
      available: agentAvailable(row),
    }));
  return {
    revision,
    phase: snapshot.phase,
    rows,
    observedSessions: snapshot.observedSessions,
    totalSessions: snapshot.totalSessions,
    truncatedSessions: snapshot.truncatedSessions,
    truncatedRows: snapshot.rows.length - rows.length,
    note: snapshot.note === null ? null : display(snapshot.note, 240),
  };
}
