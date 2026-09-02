import { z } from "zod";

export const TerminalReplicaColorSchemaZ = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("default") }).strict(),
  z.object({ kind: z.literal("indexed"), index: z.number().int().min(0).max(255) }).strict(),
  z.object({ kind: z.literal("rgb"), value: z.number().int().min(0).max(0xffffff) }).strict(),
]);
export type TerminalReplicaColor = z.infer<typeof TerminalReplicaColorSchemaZ>;

export const TerminalReplicaCellAttributesSchemaZ = z.number().int().min(0).max(0xff);
export type TerminalReplicaCellAttributes = z.infer<typeof TerminalReplicaCellAttributesSchemaZ>;

export const TerminalReplicaCellSchemaZ = z
  .object({
    grapheme: z.string(),
    width: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    foreground: TerminalReplicaColorSchemaZ,
    background: TerminalReplicaColorSchemaZ,
    attributes: TerminalReplicaCellAttributesSchemaZ,
  })
  .strict();
export type TerminalReplicaCell = z.infer<typeof TerminalReplicaCellSchemaZ>;

export const TerminalReplicaRowSchemaZ = z
  .object({ cells: z.array(TerminalReplicaCellSchemaZ), wrapped: z.boolean() })
  .strict();
export type TerminalReplicaRow = z.infer<typeof TerminalReplicaRowSchemaZ>;

export const TerminalReplicaCursorSchemaZ = z
  .object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    hidden: z.boolean(),
    style: z.enum(["block", "underline", "bar"]),
    blink: z.boolean(),
  })
  .strict();
export type TerminalReplicaCursor = z.infer<typeof TerminalReplicaCursorSchemaZ>;

export const TerminalReplicaModesSchemaZ = z
  .object({
    alternateScreen: z.boolean(),
    applicationCursor: z.boolean(),
    applicationKeypad: z.boolean(),
    bracketedPaste: z.boolean(),
    insert: z.boolean(),
    origin: z.boolean(),
    wraparound: z.boolean(),
    mouseTracking: z.boolean(),
    mouseProtocol: z.enum(["none", "x10", "vt200", "drag", "any"]).optional(),
    mouseEncoding: z.enum(["default", "utf8", "sgr", "sgr-pixels"]).optional(),
    synchronizedOutput: z.boolean(),
  })
  .strict();
export type TerminalReplicaModes = z.infer<typeof TerminalReplicaModesSchemaZ>;

export const TerminalReplicaPlacementSchemaZ = z
  .object({
    id: z.string().min(1),
    kind: z.string().min(1),
    row: z.number().int().nonnegative(),
    column: z.number().int().nonnegative(),
    columns: z.number().int().positive(),
    rows: z.number().int().positive(),
    contentDigest: z.string().min(1),
  })
  .strict();
export type TerminalReplicaPlacement = z.infer<typeof TerminalReplicaPlacementSchemaZ>;

export const TerminalReplicaSnapshotSchemaZ = z
  .object({
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
    grid: z.array(TerminalReplicaRowSchemaZ),
    history: z.array(TerminalReplicaRowSchemaZ),
    cursor: TerminalReplicaCursorSchemaZ,
    modes: TerminalReplicaModesSchemaZ,
    placements: z.array(TerminalReplicaPlacementSchemaZ),
    bootstrap: z
      .object({
        kind: z.enum(["painted-capture", "authoritative-stream"]),
        hiddenState: z.enum(["unknown", "observed-from-start"]),
      })
      .strict(),
  })
  .strict();
export type TerminalReplicaSnapshot = z.infer<typeof TerminalReplicaSnapshotSchemaZ>;

export const TerminalReplicaPatchPayloadSchemaZ = z
  .object({
    dimensions: z
      .object({ cols: z.number().int().positive(), rows: z.number().int().positive() })
      .strict()
      .optional(),
    rows: z.array(
      z.object({ index: z.number().int().nonnegative(), row: TerminalReplicaRowSchemaZ }).strict(),
    ),
    history: z.array(TerminalReplicaRowSchemaZ).optional(),
    historyDelta: z
      .object({
        trim: z.number().int().nonnegative(),
        append: z.array(TerminalReplicaRowSchemaZ),
      })
      .strict()
      .optional(),
    cursor: TerminalReplicaCursorSchemaZ.optional(),
    modes: TerminalReplicaModesSchemaZ.optional(),
    placements: z.array(TerminalReplicaPlacementSchemaZ).optional(),
    bootstrap: TerminalReplicaSnapshotSchemaZ.shape.bootstrap.optional(),
  })
  .strict();
export type TerminalReplicaPatchPayload = z.infer<typeof TerminalReplicaPatchPayloadSchemaZ>;

export const TerminalReplicaTombstonePayloadSchemaZ = z
  .object({ reason: z.enum(["pane-closed", "session-restarted", "runtime-disposed"]) })
  .strict();
export type TerminalReplicaTombstonePayload = z.infer<
  typeof TerminalReplicaTombstonePayloadSchemaZ
>;

export const TERMINAL_REPLICA_ATTRIBUTE = Object.freeze({
  bold: 1,
  dim: 2,
  italic: 4,
  underline: 8,
  blink: 16,
  inverse: 32,
  hidden: 64,
  strikethrough: 128,
} as const);

/** Canonical UTF-8 encoding described by `@tmux-ide/core`; never host JSON or UTF-16. */
export const TERMINAL_REPLICA_HASH_ALGORITHM = "fnv1a64-v1" as const;
