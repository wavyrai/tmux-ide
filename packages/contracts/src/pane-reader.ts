import { z } from "zod";
import { PaneEditorContextTargetSchemaZ } from "./pane-editor-context.ts";

/**
 * The native Markdown reader (card #756). The daemon serves only the file named
 * by the pane's `@tmux_ide_reader` option; the app never names a path. Bytes go
 * out base64-encoded in pages so every response stays under the client's 1 MiB
 * read limit; the app decodes UTF-8 itself.
 */
export const PANE_READER_PAGE_BYTES = 512 * 1024;
export const PANE_READER_MAX_BYTES = 4 * 1024 * 1024;
export const PANE_READER_ASSET_MAX_BYTES = 10 * 1024 * 1024;

/**
 * C0 controls, DEL and C1 controls (U+0080 to U+009F): Unicode's control
 * characters, the same rule the app applies to a reader's name and folder, so
 * nothing the daemon sends is refused there. Checked by code point so the
 * rule needs no control-character regex.
 */
export function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code < 32 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

export const PaneReaderRevisionSchemaZ = z.string().regex(/^[0-9a-f]{32}$/u);
export const PaneReaderPageSchemaZ = z
  .object({
    revision: PaneReaderRevisionSchemaZ,
    offset: z.number().int().nonnegative().max(PANE_READER_ASSET_MAX_BYTES),
  })
  .strict();
export type PaneReaderPage = z.infer<typeof PaneReaderPageSchemaZ>;

export const PaneReaderRequestSchemaZ = z
  .object({
    target: PaneEditorContextTargetSchemaZ,
    have: PaneReaderRevisionSchemaZ.nullable(),
    page: PaneReaderPageSchemaZ.nullable(),
  })
  .strict();
export type PaneReaderRequest = z.infer<typeof PaneReaderRequestSchemaZ>;

export const PaneReaderAssetRequestSchemaZ = z
  .object({
    target: PaneEditorContextTargetSchemaZ,
    src: z.string().min(1).max(2048),
    page: PaneReaderPageSchemaZ.nullable(),
  })
  .strict();
export type PaneReaderAssetRequest = z.infer<typeof PaneReaderAssetRequestSchemaZ>;

const NameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !hasControlCharacter(value) && !value.includes("/"), "Expected a file name");
const FolderSchema = z
  .string()
  .max(255)
  .refine((value) => !hasControlCharacter(value) && !value.includes("/"), "Expected a folder name");
const Base64Schema = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/u);
const SizeSchema = z.number().int().nonnegative();
const Named = { version: z.literal(1), name: NameSchema, folder: FolderSchema };

export const PaneReaderResponseSchemaZ = z.discriminatedUnion("state", [
  z
    .object({ ...Named, state: z.literal("unchanged"), revision: PaneReaderRevisionSchemaZ })
    .strict(),
  z
    .object({
      ...Named,
      state: z.literal("ok"),
      revision: PaneReaderRevisionSchemaZ,
      size: SizeSchema.max(PANE_READER_MAX_BYTES),
      offset: SizeSchema,
      chunk: Base64Schema,
    })
    .strict(),
  z.object({ ...Named, state: z.literal("changed") }).strict(),
  z
    .object({
      ...Named,
      state: z.literal("too_large"),
      revision: PaneReaderRevisionSchemaZ,
      size: SizeSchema,
    })
    .strict(),
  z.object({ ...Named, state: z.literal("missing") }).strict(),
]);
export type PaneReaderResponse = z.infer<typeof PaneReaderResponseSchemaZ>;

export const PaneReaderAssetMimeSchemaZ = z.enum([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);
export const PaneReaderAssetResponseSchemaZ = z.discriminatedUnion("state", [
  z
    .object({
      version: z.literal(1),
      state: z.literal("ok"),
      mime: PaneReaderAssetMimeSchemaZ,
      revision: PaneReaderRevisionSchemaZ,
      size: SizeSchema.max(PANE_READER_ASSET_MAX_BYTES),
      offset: SizeSchema,
      chunk: Base64Schema,
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      state: z.enum(["changed", "refused", "missing", "too_large"]),
    })
    .strict(),
]);
export type PaneReaderAssetResponse = z.infer<typeof PaneReaderAssetResponseSchemaZ>;
