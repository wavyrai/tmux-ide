import { z } from "zod";

import { DaemonInstanceIdSchema } from "./daemon-wire.ts";
import { SessionRuntimeGenerationSchemaZ } from "./session-runtime.ts";
import { WorkspaceIdSchemaZ } from "./workspace-state.ts";

export const LOCAL_PERFORMANCE_SNAPSHOT_VERSION = 1 as const;

const FiniteNonNegativeSchemaZ = z.number().finite().nonnegative();
const SafeNonNegativeIntegerSchemaZ = z.number().int().nonnegative().safe();
const RuntimeIncarnationSchemaZ = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/[\0\r\n]/u.test(value));

export const LocalPerformanceSourceSchemaZ = z.enum(["opentui", "web"]);
export type LocalPerformanceSource = z.infer<typeof LocalPerformanceSourceSchemaZ>;

export const LocalPerformanceAuthorityV1SchemaZ = z
  .object({
    daemonInstanceId: DaemonInstanceIdSchema.nullable(),
    workspaceName: WorkspaceIdSchemaZ.nullable(),
    generation: SessionRuntimeGenerationSchemaZ.nullable(),
    incarnation: RuntimeIncarnationSchemaZ.nullable(),
  })
  .strict()
  .readonly();
export type LocalPerformanceAuthorityV1 = z.infer<typeof LocalPerformanceAuthorityV1SchemaZ>;

/** A nearest-rank summary over one bounded local sample window. */
export const LocalPerformanceDistributionV1SchemaZ = z
  .object({
    count: SafeNonNegativeIntegerSchemaZ,
    latest: FiniteNonNegativeSchemaZ.nullable(),
    p50: FiniteNonNegativeSchemaZ.nullable(),
    p95: FiniteNonNegativeSchemaZ.nullable(),
    max: FiniteNonNegativeSchemaZ.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const values = [value.latest, value.p50, value.p95, value.max];
    if (value.count === 0 && values.some((entry) => entry !== null))
      context.addIssue({ code: "custom", message: "empty distribution must contain null values" });
    if (value.count > 0 && values.some((entry) => entry === null))
      context.addIssue({ code: "custom", message: "non-empty distribution requires values" });
    if (
      value.p50 !== null &&
      value.p95 !== null &&
      value.max !== null &&
      (value.p50 > value.p95 || value.p95 > value.max)
    )
      context.addIssue({ code: "custom", message: "distribution percentiles must be ordered" });
    if (value.latest !== null && value.max !== null && value.latest > value.max)
      context.addIssue({ code: "custom", message: "latest sample cannot exceed maximum" });
  })
  .readonly();
export type LocalPerformanceDistributionV1 = z.infer<typeof LocalPerformanceDistributionV1SchemaZ>;

export const LocalPerformanceQueueDepthV1SchemaZ = z
  .object({
    current: SafeNonNegativeIntegerSchemaZ,
    peak: SafeNonNegativeIntegerSchemaZ,
    capacity: z
      .object({
        current: SafeNonNegativeIntegerSchemaZ.nullable(),
        peak: SafeNonNegativeIntegerSchemaZ.nullable(),
      })
      .strict()
      .readonly(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.current > value.peak)
      context.addIssue({ code: "custom", path: ["current"], message: "queue exceeds peak" });
    if (value.capacity.current !== null && value.current > value.capacity.current)
      context.addIssue({
        code: "custom",
        path: ["capacity", "current"],
        message: "queue exceeds current capacity",
      });
    if (value.capacity.peak !== null && value.peak > value.capacity.peak)
      context.addIssue({
        code: "custom",
        path: ["capacity", "peak"],
        message: "queue peak exceeds known capacity",
      });
  })
  .readonly();
export type LocalPerformanceQueueDepthV1 = z.infer<typeof LocalPerformanceQueueDepthV1SchemaZ>;

export const LocalPerformanceRevisionLagV1SchemaZ = z
  .object({
    current: SafeNonNegativeIntegerSchemaZ.nullable(),
    peak: SafeNonNegativeIntegerSchemaZ.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.current !== null && value.peak === null)
      context.addIssue({ code: "custom", path: ["peak"], message: "current lag requires peak" });
    if (value.current !== null && value.peak !== null && value.current > value.peak)
      context.addIssue({ code: "custom", path: ["current"], message: "lag exceeds peak" });
  })
  .readonly();
export type LocalPerformanceRevisionLagV1 = z.infer<typeof LocalPerformanceRevisionLagV1SchemaZ>;

/**
 * Host-neutral, local-clock HUD state. Durations are finalized by one process;
 * this contract deliberately contains no timestamps that consumers could
 * subtract across browser, TUI, and daemon clock domains.
 */
export const LocalPerformanceSnapshotV1SchemaZ = z
  .object({
    version: z.literal(LOCAL_PERFORMANCE_SNAPSHOT_VERSION),
    source: LocalPerformanceSourceSchemaZ,
    sampleSequence: SafeNonNegativeIntegerSchemaZ,
    authority: LocalPerformanceAuthorityV1SchemaZ,
    activeFps: FiniteNonNegativeSchemaZ.nullable(),
    dirtyRows: LocalPerformanceDistributionV1SchemaZ,
    parseMs: LocalPerformanceDistributionV1SchemaZ,
    paintMs: LocalPerformanceDistributionV1SchemaZ,
    queueDepth: LocalPerformanceQueueDepthV1SchemaZ,
    revisionLag: LocalPerformanceRevisionLagV1SchemaZ,
    reseeds: SafeNonNegativeIntegerSchemaZ,
  })
  .strict()
  .readonly();
export type LocalPerformanceSnapshotV1 = z.infer<typeof LocalPerformanceSnapshotV1SchemaZ>;
