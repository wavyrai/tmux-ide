import { z } from "zod";
import {
  SessionRuntimeTerminalInputSchemaZ,
  SESSION_RUNTIME_MAX_TERMINAL_INPUT_TEXT_CHARS,
} from "../../../packages/contracts/src/index.ts";
import type { PaneStreamRuntimeClient } from "../../../packages/daemon-client/src/pane-stream-client.ts";

// No retry or authority reacquisition here: ambiguous input is never replayed.
export async function deliverInput(
  runtime: Pick<PaneStreamRuntimeClient, "ownsConnectionAuthority" | "sendTerminalInput">,
  workspaceName: string,
  semanticPaneId: string,
  value: unknown,
) {
  const input = SessionRuntimeTerminalInputSchemaZ.parse(value);
  if (!runtime.ownsConnectionAuthority("input")) throw new Error("Input authority unavailable");
  const result = await runtime.sendTerminalInput({ workspaceName, semanticPaneId }, input);
  if (result !== "ok") throw new Error("Input authority lost");
}

// One bounded clipboard transaction; chunking occurs only inside its selected helper.
export const MAX_INPUT_LINE = 6 * 65536 + 2048;
export const previewInputSchema = z.union([
  SessionRuntimeTerminalInputSchemaZ,
  z
    .object({
      kind: z.literal("paste"),
      data: z
        .string()
        .min(1)
        .max(65536)
        .refine((s) => Buffer.byteLength(s) <= 65536 && !s.includes("\0") && !s.includes("\u001b")),
    })
    .strict(),
]);

export async function deliverPreviewInput(
  runtime: Parameters<typeof deliverInput>[0],
  workspace: string,
  pane: string,
  value: unknown,
  bracketedPaste: boolean,
) {
  const input = previewInputSchema.parse(value);
  if (input.kind !== "paste") return deliverInput(runtime, workspace, pane, input);
  // Freeze mode once per paste; do not interleave another input between chunks.
  const text = bracketedPaste ? "\u001b[200~" + input.data + "\u001b[201~" : input.data;
  let chunk = "";
  for (const character of text) {
    if (chunk.length + character.length > SESSION_RUNTIME_MAX_TERMINAL_INPUT_TEXT_CHARS) {
      await deliverInput(runtime, workspace, pane, { kind: "text", data: chunk });
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) await deliverInput(runtime, workspace, pane, { kind: "text", data: chunk });
}
