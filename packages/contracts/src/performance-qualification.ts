import { z } from "zod";

import {
  SessionRuntimeClientIdSchemaZ,
  SessionRuntimeGenerationSchemaZ,
} from "./session-runtime.ts";

/** Wire/data contract for the m56.7 qualification evidence. */
export const PERFORMANCE_QUALIFICATION_CONTRACT_VERSION = 1 as const;
export const PERFORMANCE_QUALIFICATION_FRAME_BUDGET_MS = 16.67 as const;
export const PERFORMANCE_QUALIFICATION_MAX_QUEUE_ITEMS = 65_536 as const;
export const PERFORMANCE_QUALIFICATION_MAX_QUEUE_BYTES = 64 * 1024 * 1024;

export const PerformanceStageSchemaZ = z.enum([
  "input",
  "tmux",
  "parse",
  "reduce",
  "transport",
  "paint",
]);
export type PerformanceStage = z.infer<typeof PerformanceStageSchemaZ>;

export const PERFORMANCE_STAGE_ORDER = Object.freeze([
  "input",
  "tmux",
  "parse",
  "reduce",
  "transport",
  "paint",
] as const satisfies readonly PerformanceStage[]);

export const MonotonicClockKindSchemaZ = z.enum(["performance-now", "hrtime", "monotonic-raw"]);
export type MonotonicClockKind = z.infer<typeof MonotonicClockKindSchemaZ>;

const BoundedIdentitySchemaZ = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/[\0\r\n]/u.test(value));
const MonotonicMicrosSchemaZ = z.number().int().nonnegative().safe();

/**
 * A span is always measured by one named monotonic clock in one process.
 * Consumers may compare its endpoints, but must never subtract endpoints from
 * different spans/processes to invent cross-process wall latency.
 */
export const ProcessMonotonicSpanV1SchemaZ = z
  .object({
    version: z.literal(PERFORMANCE_QUALIFICATION_CONTRACT_VERSION),
    processId: BoundedIdentitySchemaZ,
    clockId: BoundedIdentitySchemaZ,
    clockKind: MonotonicClockKindSchemaZ,
    startedAtMicros: MonotonicMicrosSchemaZ,
    endedAtMicros: MonotonicMicrosSchemaZ,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.endedAtMicros < value.startedAtMicros)
      context.addIssue({ code: "custom", message: "monotonic span ends before it starts" });
  })
  .readonly();
export type ProcessMonotonicSpanV1 = z.infer<typeof ProcessMonotonicSpanV1SchemaZ>;

export const PerformanceStageSpanV1SchemaZ = z
  .object({
    version: z.literal(PERFORMANCE_QUALIFICATION_CONTRACT_VERSION),
    stage: PerformanceStageSchemaZ,
    processId: BoundedIdentitySchemaZ,
    clockId: BoundedIdentitySchemaZ,
    clockKind: MonotonicClockKindSchemaZ,
    startedAtMicros: MonotonicMicrosSchemaZ,
    endedAtMicros: MonotonicMicrosSchemaZ,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.endedAtMicros < value.startedAtMicros)
      context.addIssue({ code: "custom", message: "monotonic span ends before it starts" });
  })
  .readonly();
export type PerformanceStageSpanV1 = z.infer<typeof PerformanceStageSpanV1SchemaZ>;

export const PerformanceTraceV1SchemaZ = z
  .object({
    version: z.literal(PERFORMANCE_QUALIFICATION_CONTRACT_VERSION),
    traceId: z.uuid(),
    scenario: BoundedIdentitySchemaZ,
    stages: z
      .array(PerformanceStageSpanV1SchemaZ)
      .length(PERFORMANCE_STAGE_ORDER.length)
      .readonly(),
    /** Full leading-edge input-to-paint latency, measured on one client clock. */
    localInputToPaint: ProcessMonotonicSpanV1SchemaZ,
  })
  .strict()
  .superRefine((value, context) => {
    value.stages.forEach((span, index) => {
      if (span.stage !== PERFORMANCE_STAGE_ORDER[index])
        context.addIssue({
          code: "custom",
          path: ["stages", index, "stage"],
          message: `expected ${PERFORMANCE_STAGE_ORDER[index]}`,
        });
    });
    for (const index of [0, PERFORMANCE_STAGE_ORDER.length - 1]) {
      const span = value.stages[index]!;
      if (
        span.processId !== value.localInputToPaint.processId ||
        span.clockId !== value.localInputToPaint.clockId ||
        span.clockKind !== value.localInputToPaint.clockKind
      )
        context.addIssue({
          code: "custom",
          path: ["localInputToPaint"],
          message: "input, paint and localInputToPaint must share one client clock domain",
        });
    }
    const input = value.stages[0]!;
    const paint = value.stages[PERFORMANCE_STAGE_ORDER.length - 1]!;
    if (input.endedAtMicros > paint.startedAtMicros)
      context.addIssue({
        code: "custom",
        path: ["stages"],
        message: "local input must complete before local paint begins",
      });
    if (
      value.localInputToPaint.startedAtMicros >
        Math.min(input.startedAtMicros, paint.startedAtMicros) ||
      value.localInputToPaint.endedAtMicros < Math.max(input.endedAtMicros, paint.endedAtMicros)
    )
      context.addIssue({
        code: "custom",
        path: ["localInputToPaint"],
        message: "localInputToPaint must contain the local input and paint spans",
      });
  })
  .readonly();
export type PerformanceTraceV1 = z.infer<typeof PerformanceTraceV1SchemaZ>;

export const StateConvergenceIdentityV1SchemaZ = z
  .object({
    version: z.literal(PERFORMANCE_QUALIFICATION_CONTRACT_VERSION),
    generation: SessionRuntimeGenerationSchemaZ,
    incarnation: BoundedIdentitySchemaZ,
    revision: z.number().int().nonnegative(),
    stateHash: z.string().regex(/^[0-9a-f]{16}$/u),
    hashAlgorithm: z.literal("fnv1a64-v1"),
  })
  .strict()
  .readonly();
export type StateConvergenceIdentityV1 = z.infer<typeof StateConvergenceIdentityV1SchemaZ>;

export const QualifiedClientDispositionSchemaZ = z.enum(["healthy", "slow", "hidden"]);
export type QualifiedClientDisposition = z.infer<typeof QualifiedClientDispositionSchemaZ>;

export const ClientConvergenceObservationV1SchemaZ = z
  .object({
    version: z.literal(PERFORMANCE_QUALIFICATION_CONTRACT_VERSION),
    clientId: SessionRuntimeClientIdSchemaZ,
    disposition: QualifiedClientDispositionSchemaZ,
    identity: StateConvergenceIdentityV1SchemaZ,
  })
  .strict()
  .readonly();
export type ClientConvergenceObservationV1 = z.infer<typeof ClientConvergenceObservationV1SchemaZ>;

export const QualifiedQueueKindSchemaZ = z.enum(["terminal", "control", "resource"]);
export type QualifiedQueueKind = z.infer<typeof QualifiedQueueKindSchemaZ>;

export const ClientQueueMetricV1SchemaZ = z
  .object({
    version: z.literal(PERFORMANCE_QUALIFICATION_CONTRACT_VERSION),
    clientId: SessionRuntimeClientIdSchemaZ,
    disposition: QualifiedClientDispositionSchemaZ,
    queue: QualifiedQueueKindSchemaZ,
    sampleOrdinal: z.number().int().nonnegative(),
    depthItems: z.number().int().nonnegative(),
    capacityItems: z.number().int().positive().max(PERFORMANCE_QUALIFICATION_MAX_QUEUE_ITEMS),
    bytes: z.number().int().nonnegative(),
    capacityBytes: z.number().int().positive().max(PERFORMANCE_QUALIFICATION_MAX_QUEUE_BYTES),
    coalesced: z.number().int().nonnegative(),
    dropped: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.depthItems > value.capacityItems)
      context.addIssue({ code: "custom", path: ["depthItems"], message: "queue exceeds capacity" });
    if (value.bytes > value.capacityBytes)
      context.addIssue({ code: "custom", path: ["bytes"], message: "queue bytes exceed capacity" });
  })
  .readonly();
export type ClientQueueMetricV1 = z.infer<typeof ClientQueueMetricV1SchemaZ>;

export const ClientQueueSeriesV1SchemaZ = z
  .array(ClientQueueMetricV1SchemaZ)
  .min(4)
  .max(10_000)
  .superRefine((samples, context) => {
    const first = samples[0]!;
    for (let index = 1; index < samples.length; index += 1) {
      const sample = samples[index]!;
      if (
        sample.clientId !== first.clientId ||
        sample.disposition !== first.disposition ||
        sample.queue !== first.queue ||
        sample.capacityItems !== first.capacityItems ||
        sample.capacityBytes !== first.capacityBytes
      )
        context.addIssue({
          code: "custom",
          path: [index],
          message: "queue series identity and capacity must remain stable",
        });
      if (sample.sampleOrdinal <= samples[index - 1]!.sampleOrdinal)
        context.addIssue({
          code: "custom",
          path: [index, "sampleOrdinal"],
          message: "queue sample ordinals must increase",
        });
    }
  })
  .readonly();
export type ClientQueueSeriesV1 = z.infer<typeof ClientQueueSeriesV1SchemaZ>;

export const MutationQualificationAcceptanceV1SchemaZ = z
  .object({
    version: z.literal(PERFORMANCE_QUALIFICATION_CONTRACT_VERSION),
    mutationId: z.uuid(),
    processId: BoundedIdentitySchemaZ,
    clockId: BoundedIdentitySchemaZ,
    clockKind: MonotonicClockKindSchemaZ,
    acceptedAtMicros: MonotonicMicrosSchemaZ,
    deadlineAtMicros: MonotonicMicrosSchemaZ,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.deadlineAtMicros <= value.acceptedAtMicros)
      context.addIssue({ code: "custom", message: "mutation deadline must follow acceptance" });
  })
  .readonly();
export type MutationQualificationAcceptanceV1 = z.infer<
  typeof MutationQualificationAcceptanceV1SchemaZ
>;

export const MutationTerminalStatusSchemaZ = z.enum(["observed", "rejected", "timed-out"]);
export type MutationTerminalStatus = z.infer<typeof MutationTerminalStatusSchemaZ>;

export const MutationTerminalOutcomeV1SchemaZ = z
  .object({
    version: z.literal(PERFORMANCE_QUALIFICATION_CONTRACT_VERSION),
    mutationId: z.uuid(),
    processId: BoundedIdentitySchemaZ,
    clockId: BoundedIdentitySchemaZ,
    clockKind: MonotonicClockKindSchemaZ,
    occurredAtMicros: MonotonicMicrosSchemaZ,
    status: MutationTerminalStatusSchemaZ,
    reason: z.string().min(1).max(512).optional(),
    identity: StateConvergenceIdentityV1SchemaZ.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "observed" && value.identity === undefined)
      context.addIssue({
        code: "custom",
        path: ["identity"],
        message: "observed requires identity",
      });
    if (value.status !== "observed" && value.reason === undefined)
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "terminal failure requires reason",
      });
  })
  .readonly();
export type MutationTerminalOutcomeV1 = z.infer<typeof MutationTerminalOutcomeV1SchemaZ>;
