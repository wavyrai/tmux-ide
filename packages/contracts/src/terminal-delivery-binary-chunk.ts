import { z } from "zod";
import { TerminalAttachmentSemanticPaneIdSchemaZ } from "./semantic-identity.ts";
import { TERMINAL_DELIVERY_CHUNK_BYTES } from "./terminal-delivery.ts";
export const TerminalDeliveryBinaryChunkHeaderSchemaZ = z
  .object({
    pane: TerminalAttachmentSemanticPaneIdSchemaZ,
    transactionId: z.uuid(),
    index: z.number().int().min(0).max(255),
  })
  .strict();
export type TerminalDeliveryBinaryChunkHeader = z.infer<
  typeof TerminalDeliveryBinaryChunkHeaderSchemaZ
>;
/** TDC1 + u32be metadata length + strict header + unchanged representation chunk. */
export function encodeTerminalDeliveryBinaryChunk(
  header: TerminalDeliveryBinaryChunkHeader,
  bytes: Uint8Array,
): Uint8Array {
  const parsed = TerminalDeliveryBinaryChunkHeaderSchemaZ.parse(header);
  const json = new TextEncoder().encode(JSON.stringify(parsed));
  if (json.length > 4096 || bytes.length > TERMINAL_DELIVERY_CHUNK_BYTES)
    throw new TypeError("Binary delivery chunk bound");
  const result = new Uint8Array(8 + json.length + bytes.length);
  result.set([84, 68, 67, 49]);
  new DataView(result.buffer).setUint32(4, json.length, false);
  result.set(json, 8);
  result.set(bytes, 8 + json.length);
  return result;
}
export function decodeTerminalDeliveryBinaryChunk(data: Uint8Array): {
  header: TerminalDeliveryBinaryChunkHeader;
  bytes: Uint8Array;
} {
  if (
    data.length < 9 ||
    data.length > 8 + 4096 + TERMINAL_DELIVERY_CHUNK_BYTES ||
    data[0] !== 84 ||
    data[1] !== 68 ||
    data[2] !== 67 ||
    data[3] !== 49
  )
    throw new TypeError("Invalid binary delivery packet");
  const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(4, false);
  if (
    length < 1 ||
    length > 4096 ||
    8 + length > data.length ||
    data.length - 8 - length > TERMINAL_DELIVERY_CHUNK_BYTES
  )
    throw new TypeError("Invalid binary delivery header bound");
  const header = TerminalDeliveryBinaryChunkHeaderSchemaZ.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(8, 8 + length))),
  );
  return { header, bytes: data.subarray(8 + length) };
}
