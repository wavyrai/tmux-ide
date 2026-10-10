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
/** Read-only topology refresh after one validated mutation receipt; never submits an action. */
export async function refreshSplitInventory(options: {
  current: () => boolean;
  originalPane: string;
  createdPane: string;
  retire: () => Promise<void>;
  read: () => Promise<Connection[]>;
  attach: (original: Connection, choices: Connection[]) => Promise<void>;
}) {
  if (!options.current()) return;
  await options.retire();
  if (!options.current()) return;
  const choices = await options.read();
  if (!options.current()) return;
  if (choices.length > 512 || !choices.some((pane) => pane.semanticPaneId === options.createdPane))
    throw new Error("Created pane unavailable");
  const original = choices.find((pane) => pane.semanticPaneId === options.originalPane);
  if (!original) throw new Error("Original pane unavailable");
  await options.attach(original, choices);
}
