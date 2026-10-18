import { z } from "zod";
import type { TerminalReplicaSnapshot } from "../../../packages/contracts/src/terminal-replica.ts";
import {
  terminalMouseActionSupported,
  terminalMouseInput,
} from "../../../packages/daemon/src/tui/mirror/runtime/terminal-selection.ts";
const gesture = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const mouseSchema = z
  .object({
    kind: z.literal("mouse"),
    data: z.union([
      z.object({ action: z.literal("cancel"), gesture }).strict(),
      z
        .object({
          action: z.enum(["down", "drag", "move", "up"]),
          gesture,
          row: z.number().int().min(0).max(16383),
          col: z.number().int().min(0).max(16383),
          button: z.number().int().min(0).max(2).nullable(),
          shift: z.boolean(),
          alt: z.boolean(),
          control: z.boolean(),
          protocol: z.enum(["x10", "vt200", "drag", "any"]),
          encoding: z.enum(["default", "utf8", "sgr"]),
          cols: z.number().int().positive().max(16384),
          rows: z.number().int().positive().max(16384),
        })
        .strict(),
    ]),
  })
  .strict();
/** Per-live-attachment pointer ownership. Content revisions intentionally do not identify gestures. */
export function createMouseOwner() {
  let held: { gesture: number; button: number; proof: string } | null = null;
  let highWater = 0;
  const proof = (s: TerminalReplicaSnapshot, identity: string) =>
    JSON.stringify([
      identity,
      s.cols,
      s.rows,
      s.modes.mouseProtocol,
      s.modes.mouseEncoding,
      s.modes.alternateScreen,
    ]);
  const retire = () => {
    held = null;
  };
  const observe = (snapshot: TerminalReplicaSnapshot | null, identity: string) => {
    if (!snapshot || (held && held.proof !== proof(snapshot, identity))) retire();
  };
  return {
    retire,
    observe,
    route(snapshot: TerminalReplicaSnapshot, identity: string, value: unknown) {
      observe(snapshot, identity);
      const parsed = mouseSchema.safeParse(value);
      if (!parsed.success) {
        retire();
        return null;
      }
      const m = parsed.data.data;
      if (m.action === "cancel") {
        highWater = Math.max(highWater, m.gesture);
        if (held && held.gesture <= m.gesture) retire();
        return null;
      }
      if (
        m.shift ||
        m.row >= snapshot.rows ||
        m.col >= snapshot.cols ||
        m.cols !== snapshot.cols ||
        m.rows !== snapshot.rows ||
        m.protocol !== snapshot.modes.mouseProtocol ||
        m.encoding !== snapshot.modes.mouseEncoding
      ) {
        retire();
        return null;
      }
      if (m.action === "move") {
        if (
          m.gesture <= highWater ||
          m.button !== null ||
          held ||
          !terminalMouseActionSupported(snapshot, "move")
        )
          return null;
      } else if (m.action === "down") {
        if (m.button === null || m.gesture <= highWater) return null;
        highWater = m.gesture;
        retire();
        if (!terminalMouseActionSupported(snapshot, "down")) return null;
      } else {
        if (!held || held.gesture !== m.gesture || held.button !== m.button) return null;
        if (m.action === "up") retire();
        if (!terminalMouseActionSupported(snapshot, m.action)) return null;
      }
      const encoded = terminalMouseInput(
        {
          action: m.action,
          row: m.row,
          column: m.col,
          ...(m.button === null ? {} : { button: m.button }),
          shift: false,
          alt: m.alt,
          ctrl: m.control,
        },
        snapshot.modes.mouseEncoding,
      );
      if (encoded && m.action === "move") highWater = m.gesture;
      if (encoded && m.action === "down" && m.button !== null)
        held = { gesture: m.gesture, button: m.button, proof: proof(snapshot, identity) };
      return encoded;
    },
  };
}
