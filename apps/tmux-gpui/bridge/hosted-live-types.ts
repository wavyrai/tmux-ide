import type { z } from "zod";
import type { connectionSchema } from "./config.ts";
import type { TerminalReplicaSnapshot } from "../../../packages/contracts/src/index.ts";

/** Snapshot references are immutable replica values; receivers must not mutate them. */
export type HostedLiveEvent =
  | {
      connection: string;
      sequence: number;
      snapshot: TerminalReplicaSnapshot | null;
      surfaces?: readonly { paneId: string; snapshot: TerminalReplicaSnapshot }[];
      [field: string]: unknown;
    }
  | { kind: "input-target-rejected" }
  | { kittyImageChunk: unknown }
  | { rawKittyImage: import("./kitty-graphics.ts").KittyImageBytes }
  | { kind: "history-handoff"; intent: string; state: string; token: string | null };
export type HostedLiveOptions = {
  config: z.infer<typeof connectionSchema>;
  mode: "interactive" | "catalog" | "snapshot";
  knownDigests?: string[];
  signal?: AbortSignal;
  /** Synchronous bounded admission; throws retire this session, never the host. */
  emit(event: HostedLiveEvent): boolean | void;
  diagnostic?(line: string): void;
  drain?(signal: AbortSignal): void | Promise<void>;
  close?(): void;
};
