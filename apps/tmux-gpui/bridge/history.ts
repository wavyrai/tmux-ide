import { z } from "zod";
import type {
  TerminalReplicaSnapshot,
  TerminalReplicaRow,
} from "../../../packages/contracts/src/terminal-replica.ts";
export const scrollSchema = z
  .object({ kind: z.literal("scroll"), data: z.number().int().min(-1000).max(1000) })
  .strict();
const MAX_ROWS = 1000;
const MAX_BYTES = 2 * 1024 * 1024;
/** Retain canonical row identity locally; never infer identity from matching text. */
export function createHistoryViewport() {
  let current: TerminalReplicaSnapshot | null = null;
  let history: TerminalReplicaRow[] = [];
  let anchor: TerminalReplicaRow | null = null;
  let offset = 0;
  function update(snapshot: TerminalReplicaSnapshot | null) {
    if (!snapshot || current?.cols !== snapshot.cols || snapshot.modes.alternateScreen) {
      anchor = null;
      offset = 0;
    }
    current = snapshot ? { ...snapshot, history: [] } : null;
    history = [];
    if (snapshot && !snapshot.modes.alternateScreen) {
      let bytes = 0;
      for (
        let i = snapshot.history.length - 1;
        i >= Math.max(0, snapshot.history.length - MAX_ROWS);
        i--
      ) {
        const row = snapshot.history[i]!;
        bytes += Buffer.byteLength(JSON.stringify(row));
        if (bytes > MAX_BYTES) break;
        history.push(row);
      }
      history.reverse();
    }
    if (anchor) {
      const first = history.indexOf(anchor);
      const index = first === history.lastIndexOf(anchor) ? first : -1;
      // A replacement/reset cannot prove the old anchor. Return to live explicitly.
      offset = index < 0 ? 0 : history.length - index;
      if (index < 0) anchor = null;
    }
    return view();
  }
  function view(): TerminalReplicaSnapshot | null {
    if (!current) return null;
    if (!offset) return { ...current, history: [] };
    const rows = [...history, ...current.grid];
    const start = history.length - offset;
    return {
      ...current,
      history: [],
      grid: rows.slice(start, start + current.rows),
      cursor: { ...current.cursor, hidden: true },
      placements: [],
    };
  }
  return {
    update,
    get offset() {
      return offset;
    },
    scroll(lines: number) {
      offset = lines === 0 ? 0 : Math.max(0, Math.min(history.length, offset + lines));
      anchor = offset ? history[history.length - offset]! : null;
      return view();
    },
  };
}
