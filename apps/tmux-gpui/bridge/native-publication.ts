import { z } from "zod";
import { createCompactDeltaProducer } from "./compact-delta.ts";
import { createSnapshotSerializer } from "./snapshot-wire.ts";
import { renderPreparedPublication, type PreparedPublication } from "./prepared-publication.ts";

export type NativePublicationEncoding = "legacy" | "rle-v1" | "rle-delta-v1";
export type NativePublicationContext = {
  readonly identity: string;
  readonly connection: string;
  readonly request: number;
};
type AcceptedFrame = NativePublicationContext & { readonly epoch: string; readonly seq: number };
const contextSchema = z.object({
  identity: z.string().min(1),
  connection: z.string().min(1).max(128),
  request: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export const nativeFrameResyncSchema = z
  .object({
    type: z.literal("frame-resync"),
    connection: z.string().min(1).max(128),
    request: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    epoch: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[\x21-\x7e]+$/),
    baseSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

/** Owns the emitted frame baseline, never an unsent or overwritten pending state. */
export function createNativePublicationWriter(
  encoding: NativePublicationEncoding,
  write: (line: string) => boolean,
  maxBytes = 8 * 1024 * 1024,
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new Error("Invalid publication byte limit");
  const producer = createCompactDeltaProducer();
  const serialize = createSnapshotSerializer(encoding === "legacy" ? "legacy" : "rle-v1");
  let accepted: Readonly<AcceptedFrame> | null = null;
  let retired = false;
  const retire = () => {
    retired = true;
    accepted = null;
    producer.reset();
  };
  return {
    get lastAccepted() {
      return accepted;
    },
    retire,
    write(publication: PreparedPublication, context: NativePublicationContext): boolean {
      if (retired) throw new Error("Native publication writer retired");
      const ownedContext = contextSchema.parse(context);
      // Connection and request must reset epochs even when caller identity is reused.
      const identity = JSON.stringify([
        ownedContext.identity,
        ownedContext.connection,
        ownedContext.request,
      ]);
      const candidate =
        encoding === "rle-delta-v1" && publication.snapshot !== null
          ? producer.prepare(publication.snapshot, identity)
          : null;
      const line = renderPreparedPublication(
        publication,
        candidate?.json ?? serialize(publication.snapshot),
      );
      if (Buffer.byteLength(line, "utf8") > maxBytes)
        throw new Error("Native publication exceeds byte limit");
      let ready: boolean;
      try {
        ready = write(line);
      } catch (error) {
        retire();
        throw error;
      }
      if (candidate) {
        candidate.commit();
        accepted = Object.freeze({ ...ownedContext, epoch: candidate.epoch, seq: candidate.seq });
      } else {
        producer.reset();
        accepted = null;
      }
      return ready;
    },
    resync(command: unknown, current: NativePublicationContext): boolean {
      if (retired || encoding !== "rle-delta-v1" || accepted === null) return false;
      const parsed = nativeFrameResyncSchema.safeParse(command);
      const context = contextSchema.safeParse(current);
      if (!parsed.success || !context.success) return false;
      const value = parsed.data;
      if (
        context.data.identity !== accepted.identity ||
        context.data.connection !== accepted.connection ||
        context.data.request !== accepted.request ||
        value.connection !== accepted.connection ||
        value.request !== accepted.request ||
        value.epoch !== accepted.epoch ||
        value.baseSeq > accepted.seq
      )
        return false;
      producer.reset();
      accepted = null;
      return true;
    },
  };
}
