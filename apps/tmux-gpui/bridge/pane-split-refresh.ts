import { CatalogStageError } from "./catalog-errors.ts";
import type { sessionChoice } from "./catalog.ts";
import type { z } from "zod";
import type { connectionSchema } from "./config.ts";
type Connection = z.infer<typeof connectionSchema>;
export type SplitRefreshIdentity = Readonly<{
  request: number;
  session: string | null;
  catalog: object | undefined;
  presenceRevision: number;
  foreground: boolean;
  stopped: boolean;
}>;
/** A background/foreground cycle changes revision and cannot resurrect this transaction. */
export function splitRefreshGuard(read: () => SplitRefreshIdentity) {
  const captured = { ...read() };
  return () => {
    const now = read();
    return (
      !captured.stopped &&
      captured.foreground &&
      !!captured.catalog &&
      !!captured.session &&
      !now.stopped &&
      now.foreground &&
      now.request === captured.request &&
      now.session === captured.session &&
      now.catalog === captured.catalog &&
      now.presenceRevision === captured.presenceRevision
    );
  };
}
type RefreshStage =
  | "retire"
  | "inventory"
  | "created-pane"
  | "original-pane"
  | "sessions"
  | "selected-session"
  | "attach";
/** Fixed stage only: raw transport errors may contain private configuration. */
export class SplitRefreshError extends Error {
  readonly catalog: CatalogStageError["diagnostic"] | undefined;
  constructor(
    readonly stage: RefreshStage,
    error?: unknown,
  ) {
    super(`Pane refresh failed at ${stage}`);
    this.name = "SplitRefreshError";
    this.catalog = error instanceof CatalogStageError ? error.diagnostic : undefined;
  }
}
/** Read-only topology refresh after one validated mutation receipt; never submits an action. */
export async function refreshSplitInventory(options: {
  current: () => boolean;
  originalPane: string;
  createdPane: string;
  selectedSession: string;
  readSessions: () => Promise<ReturnType<typeof sessionChoice>[]>;
  retire: () => Promise<void>;
  read: () => Promise<Connection[]>;
  attach: (
    original: Connection,
    choices: Connection[],
    sessions: ReturnType<typeof sessionChoice>[],
  ) => Promise<void>;
}) {
  let stage: RefreshStage = "retire";
  try {
    if (!options.current()) return;
    await options.retire();
    if (!options.current()) return;
    stage = "inventory";
    let choices = await options.read();
    // A successful mutation can precede the mirror's window-identity stamp.
    // The canonical inventory then conservatively exposes no attachable panes.
    // Wait only for that empty transition; never infer identities from a receipt
    // or retry mutations, transport failures, or a contradictory partial catalog.
    for (const delay of [50, 100, 200, 400, 800]) {
      if (!options.current()) return;
      if (choices.length !== 0) break;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      if (!options.current()) return;
      choices = await options.read();
    }
    if (!options.current()) return;
    stage = "created-pane";
    if (
      choices.length > 512 ||
      !choices.some((pane) => pane.semanticPaneId === options.createdPane)
    )
      throw new Error("Created pane unavailable");
    stage = "original-pane";
    const original = choices.find((pane) => pane.semanticPaneId === options.originalPane);
    if (!original) throw new Error("Original pane unavailable");
    stage = "sessions";
    const sessions = await options.readSessions();
    if (!options.current()) return;
    stage = "selected-session";
    if (
      sessions.length > 512 ||
      sessions.filter((session) => session.id === options.selectedSession).length !== 1
    )
      throw new Error("Selected session unavailable");
    stage = "attach";
    await options.attach(original, choices, sessions);
  } catch (error) {
    throw new SplitRefreshError(stage, error);
  }
}
