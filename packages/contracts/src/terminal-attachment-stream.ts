import { z } from "zod";
import { TERMINAL_ATTACHMENT_PROTOCOL_VERSION } from "./terminal-attachments.ts";

/** Binary client-input envelope: one kind byte followed by a uint32 sequence. */
export const TERMINAL_ATTACHMENT_INPUT_FRAME_KIND = 0x01 as const;
export const TERMINAL_ATTACHMENT_INPUT_FRAME_HEADER_BYTES = 5 as const;
export const TERMINAL_ATTACHMENT_MAX_INPUT_SEQUENCE = 0xffff_ffff;

/** Mirrors the reviewed daemon-side hard ceiling without importing daemon code. */
export const TERMINAL_ATTACHMENT_MAX_INPUT_FRAME_BYTES = 64 * 1024;
export const TERMINAL_ATTACHMENT_MAX_INPUT_WIRE_BYTES =
  TERMINAL_ATTACHMENT_INPUT_FRAME_HEADER_BYTES + TERMINAL_ATTACHMENT_MAX_INPUT_FRAME_BYTES;

export const TerminalAttachmentInputLimitsSchemaZ = z
  .object({
    maxFrameBytes: z.number().int().positive().max(TERMINAL_ATTACHMENT_MAX_INPUT_FRAME_BYTES),
    maxAcceptedBytes: z
      .number()
      .int()
      .positive()
      .max(4 * 1024 * 1024),
    maxAcceptedFrames: z.number().int().positive().max(16_384),
  })
  .strict()
  .refine((limits) => limits.maxFrameBytes <= limits.maxAcceptedBytes, {
    message: "terminal input frame limit cannot exceed its lifetime byte limit",
  });
export type TerminalAttachmentInputLimits = z.infer<typeof TerminalAttachmentInputLimitsSchemaZ>;

export const TerminalAttachmentInputCapabilitySchemaZ = z.union([
  z.literal("unavailable"),
  z
    .object({
      mode: z.literal("bounded"),
      limits: TerminalAttachmentInputLimitsSchemaZ,
    })
    .strict(),
]);
export type TerminalAttachmentInputCapability = z.infer<
  typeof TerminalAttachmentInputCapabilitySchemaZ
>;

export const TerminalAttachmentInputAckFrameSchemaZ = z
  .object({
    type: z.literal("input-ack"),
    protocolVersion: z.literal(TERMINAL_ATTACHMENT_PROTOCOL_VERSION),
    generation: z.number().int().nonnegative(),
    sequence: z.number().int().positive().max(TERMINAL_ATTACHMENT_MAX_INPUT_SEQUENCE),
    byteLength: z.number().int().positive().max(TERMINAL_ATTACHMENT_MAX_INPUT_FRAME_BYTES),
    state: z.enum(["open", "exhausted"]),
    acceptedBytes: z
      .number()
      .int()
      .positive()
      .max(4 * 1024 * 1024),
    acceptedFrames: z.number().int().positive().max(16_384),
    remainingBytes: z
      .number()
      .int()
      .nonnegative()
      .max(4 * 1024 * 1024),
    remainingFrames: z.number().int().nonnegative().max(16_384),
  })
  .strict();
export type TerminalAttachmentInputAckFrame = z.infer<
  typeof TerminalAttachmentInputAckFrameSchemaZ
>;

export interface TerminalAttachmentDecodedInputFrame {
  readonly sequence: number;
  /** A view into the validated WebSocket message; the PTY boundary copies it. */
  readonly payload: Uint8Array;
}

export function encodeTerminalAttachmentInputFrame(
  sequence: number,
  payload: Uint8Array,
): Uint8Array {
  if (
    !Number.isSafeInteger(sequence) ||
    sequence <= 0 ||
    sequence > TERMINAL_ATTACHMENT_MAX_INPUT_SEQUENCE
  ) {
    throw new RangeError("terminal input sequence is invalid");
  }
  if (!(payload instanceof Uint8Array) || payload.byteLength === 0) {
    throw new TypeError("terminal input payload must be a non-empty Uint8Array");
  }
  if (payload.byteLength > TERMINAL_ATTACHMENT_MAX_INPUT_FRAME_BYTES) {
    throw new RangeError("terminal input payload exceeds the wire bound");
  }
  const frame = new Uint8Array(TERMINAL_ATTACHMENT_INPUT_FRAME_HEADER_BYTES + payload.byteLength);
  frame[0] = TERMINAL_ATTACHMENT_INPUT_FRAME_KIND;
  new DataView(frame.buffer).setUint32(1, sequence, false);
  frame.set(payload, TERMINAL_ATTACHMENT_INPUT_FRAME_HEADER_BYTES);
  return frame;
}

export function decodeTerminalAttachmentInputFrame(
  frame: Uint8Array,
): TerminalAttachmentDecodedInputFrame | null {
  if (
    !(frame instanceof Uint8Array) ||
    frame.byteLength <= TERMINAL_ATTACHMENT_INPUT_FRAME_HEADER_BYTES ||
    frame.byteLength > TERMINAL_ATTACHMENT_MAX_INPUT_WIRE_BYTES ||
    frame[0] !== TERMINAL_ATTACHMENT_INPUT_FRAME_KIND
  ) {
    return null;
  }
  const sequence = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(
    1,
    false,
  );
  if (sequence === 0) return null;
  return Object.freeze({
    sequence,
    payload: frame.subarray(TERMINAL_ATTACHMENT_INPUT_FRAME_HEADER_BYTES),
  });
}
