import { z } from "zod";
import { TerminalAttachmentSemanticPaneIdSchemaZ } from "../../../packages/contracts/src/semantic-identity.ts";
import { sessionChoice } from "./catalog.ts";
import { connectionSchema } from "./config.ts";
import type { OwnerActionBinding } from "./direct-owner-actions.ts";
export const nativeTerminalRefreshSchema = z
  .object({
    type: z.literal("native-terminal-refresh"),
    id: z.uuid(),
    request: z.number().int().nonnegative().safe(),
    preferredPane: TerminalAttachmentSemanticPaneIdSchemaZ.optional(),
  })
  .strict();
type Connection = z.infer<typeof connectionSchema>;
/** A read-only refresh after Rust accepted a structural receipt. The caller consumes
 * the exact old binding synchronously in retire(), so duplicate commands cannot run.
 * current() must guard catalog owner, request, session and presence across navigation;
 * it deliberately does not depend on the retired socket id. No action is replayed.
 */
export async function refreshDirectTerminal(
  binding: OwnerActionBinding,
  value: unknown,
  options: {
    current: () => boolean;
    retire: () => void;
    read: () => Promise<Connection[]>;
    open: (selected: Connection, choices: Connection[], request: number) => Promise<void>;
  },
): Promise<boolean> {
  const parsed = nativeTerminalRefreshSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.id !== binding.id ||
    parsed.data.request !== binding.request ||
    !options.current()
  )
    return false;
  const preferred = parsed.data.preferredPane;
  options.retire();
  const old = connectionSchema.parse(binding.config);
  let choices: Connection[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!options.current()) return true;
    const raw = await options.read();
    if (!options.current()) return true;
    if (raw.length > 256) throw new Error("Native refresh inventory bound");
    choices = raw
      .map((choice) => connectionSchema.parse(choice))
      .filter(
        (choice) =>
          choice.scope.serverId === old.scope.serverId &&
          choice.scope.generation === old.scope.generation &&
          choice.liveSessionId === old.liveSessionId &&
          choice.workspaceName === old.workspaceName &&
          choice.baseUrl === old.baseUrl &&
          choice.ownerToken === old.ownerToken,
      );
    if (new Set(choices.map((choice) => choice.semanticPaneId)).size !== choices.length)
      throw new Error("Native refresh duplicate pane");
    if (
      preferred ? choices.some((choice) => choice.semanticPaneId === preferred) : choices.length > 0
    )
      break;
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!options.current()) return true;
  if (!choices.length) throw new Error("Native refresh has no surviving pane");
  const selected = preferred
    ? choices.find((choice) => choice.semanticPaneId === preferred)
    : (choices.find((choice) => choice.semanticPaneId === old.semanticPaneId) ?? choices[0]);
  if (!selected) throw new Error("Native refresh preferred pane is unavailable");
  await options.open(selected, choices, binding.request);
  return true;
}

/** Refresh full-session display counts after inventory, independently of the bounded
 * pane capability. Publish only while the retired attachment's navigation is current.
 */
export async function readDirectInventory(options: {
  current: () => boolean;
  panes: () => Promise<Connection[]>;
  sessions: () => Promise<Parameters<typeof sessionChoice>[0][]>;
  publishSessions: (sessions: ReturnType<typeof sessionChoice>[]) => void;
}): Promise<Connection[]> {
  const panes = await options.panes();
  if (!options.current()) return [];
  if (panes.length > 256) throw new Error("Native refresh inventory bound");
  const sessions = await options.sessions();
  if (!options.current()) return [];
  if (sessions.length > 512) throw new Error("Native refresh session bound");
  options.publishSessions(sessions.map(sessionChoice));
  return panes;
}
