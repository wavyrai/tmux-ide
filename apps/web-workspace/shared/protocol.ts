import { z } from "zod";
import type { Workspace } from "./model.ts";
export interface Machine {
  home: string;
  name: string;
  platform: string;
}
export interface Bootstrap {
  machine: Machine;
  state: Workspace;
}
const id = z.string().uuid();
export const Action = z.discriminatedUnion("type", [
  z.object({ cwd: z.string().max(4096).optional(), type: z.literal("create") }),
  z.object({
    direction: z.enum(["horizontal", "vertical"]),
    paneId: id,
    tabId: id,
    type: z.literal("split"),
  }),
  z.object({
    name: z.string().trim().min(1).max(80),
    tabId: id,
    type: z.literal("rename"),
  }),
  z.object({ tabId: id, type: z.literal("hide") }),
  z.object({ tabId: id, type: z.literal("close") }),
  z.object({ paneId: id, tabId: id, type: z.literal("closePane") }),
  z.object({ tabId: id, type: z.literal("restore") }),
  z.object({ paneId: id, tabId: id, type: z.literal("hidePane") }),
  z.object({ tabId: id, type: z.literal("terminate") }),
  z.object({ paneId: id, type: z.literal("restart") }),
  z.object({
    ratio: z.number().min(0.15).max(0.85),
    splitId: id,
    tabId: id,
    type: z.literal("resize"),
  }),
  z.object({ ids: z.array(id).max(64), type: z.literal("reorder") }),
  z.object({
    settings: z.object({
      darkTheme: z.string().min(1),
      fontSize: z.number().int().min(11).max(22),
      lightTheme: z.string().min(1),
      mode: z.enum(["system", "light", "dark"]),
    }),
    type: z.literal("settings"),
  }),
]);
export type ActionInput = z.infer<typeof Action>;
