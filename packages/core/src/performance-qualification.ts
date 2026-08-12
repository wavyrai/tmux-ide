import {
  ClientConvergenceObservationV1SchemaZ,
  ClientQueueMetricV1SchemaZ,
  ClientQueueSeriesV1SchemaZ,
  MutationQualificationAcceptanceV1SchemaZ,
  MutationTerminalOutcomeV1SchemaZ,
  PERFORMANCE_QUALIFICATION_FRAME_BUDGET_MS,
  PERFORMANCE_STAGE_ORDER,
  PerformanceTraceV1SchemaZ,
  StateConvergenceIdentityV1SchemaZ,
  TERMINAL_REPLICA_HASH_ALGORITHM,
  type ClientConvergenceObservationV1,
  type ClientQueueMetricV1,
  type ClientQueueSeriesV1,
  type MutationQualificationAcceptanceV1,
  type MutationTerminalOutcomeV1,
  type PerformanceStage,
  type PerformanceTraceV1,
  type ProcessMonotonicSpanV1,
  type StateConvergenceIdentityV1,
} from "@tmux-ide/contracts";

export interface PercentileSummary {
  readonly count: number;
  readonly minMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

export interface PerformanceBudgetEvaluation {
  readonly passed: boolean;
  readonly budgetMs: number;
  readonly inputToPaint: PercentileSummary;
  readonly stages: Readonly<Record<PerformanceStage, PercentileSummary>>;
}

export interface StateConvergenceEvaluation {
  readonly converged: boolean;
  readonly expected: StateConvergenceIdentityV1;
  readonly healthyClientCount: number;
  readonly matchingClientIds: readonly string[];
  readonly divergentClientIds: readonly string[];
  readonly excludedClientIds: readonly string[];
}

export interface QueueBoundsEvaluation {
  readonly bounded: boolean;
  readonly maxDepthItems: number;
  readonly maxBytes: number;
  readonly coalesced: number;
  readonly dropped: number;
}

export interface QueuePlateauEvaluation {
  readonly plateaued: boolean;
  readonly itemSlopePerSample: number;
  readonly byteSlopePerSample: number;
  readonly allowedItemSlopePerSample: number;
  readonly allowedByteSlopePerSample: number;
  readonly sampleCount: number;
}

export interface SlowClientIsolationEvaluation {
  readonly passed: boolean;
  readonly baselineP95Ms: number;
  readonly contendedP95Ms: number;
  readonly regressionMs: number;
  readonly allowedRegressionMs: number;
}

export interface MutationOutcomeEvaluation {
  readonly complete: boolean;
  readonly acceptedCount: number;
  readonly terminalCount: number;
  readonly limboMutationIds: readonly string[];
  readonly duplicateMutationIds: readonly string[];
  readonly unknownMutationIds: readonly string[];
  readonly clockDomainMismatchMutationIds: readonly string[];
  readonly earlyMutationIds: readonly string[];
  readonly lateMutationIds: readonly string[];
  readonly prematureTimeoutMutationIds: readonly string[];
}

/** Duration of one span only. No helper accepts endpoints from two clocks. */
export function monotonicSpanDurationMs(span: ProcessMonotonicSpanV1): number {
  return (span.endedAtMicros - span.startedAtMicros) / 1_000;
}

/** Deterministic nearest-rank percentile; input ordering never affects output. */
export function deterministicPercentile(values: readonly number[], percentile: number): number {
  if (values.length === 0) throw new TypeError("percentile requires at least one value");
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 1)
    throw new TypeError("percentile must be in (0, 1]");
  if (values.some((value) => !Number.isFinite(value) || value < 0))
    throw new TypeError("percentile values must be finite and non-negative");
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(percentile * ordered.length) - 1)]!;
}

export function summarizeDurations(values: readonly number[]): PercentileSummary {
  return Object.freeze({
    count: values.length,
    minMs: deterministicPercentile(values, 1 / values.length),
    p50Ms: deterministicPercentile(values, 0.5),
    p95Ms: deterministicPercentile(values, 0.95),
    maxMs: deterministicPercentile(values, 1),
  });
}

export function evaluatePerformanceBudget(
  traces: readonly PerformanceTraceV1[],
  budgetMs = PERFORMANCE_QUALIFICATION_FRAME_BUDGET_MS,
): PerformanceBudgetEvaluation {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0)
    throw new TypeError("performance budget must be finite and positive");
  const parsed = traces.map((trace) => PerformanceTraceV1SchemaZ.parse(trace));
  if (parsed.length === 0) throw new TypeError("performance evaluation requires traces");
  const inputToPaint = summarizeDurations(
    parsed.map(({ localInputToPaint }) => monotonicSpanDurationMs(localInputToPaint)),
  );
  const stages = Object.fromEntries(
    PERFORMANCE_STAGE_ORDER.map((stage, index) => [
      stage,
      summarizeDurations(parsed.map((trace) => monotonicSpanDurationMs(trace.stages[index]!))),
    ]),
  ) as Record<PerformanceStage, PercentileSummary>;
  return Object.freeze({
    passed: inputToPaint.p95Ms <= budgetMs,
    budgetMs,
    inputToPaint,
    stages: Object.freeze(stages),
  });
}

/** Wraps canonical runtime truth without recomputing or relabeling its hash. */
export function createStateConvergenceIdentity(
  generation: string,
  incarnation: string,
  revision: number,
  canonicalStateHash: string,
): StateConvergenceIdentityV1 {
  return StateConvergenceIdentityV1SchemaZ.parse({
    version: 1,
    generation,
    incarnation,
    revision,
    stateHash: canonicalStateHash,
    hashAlgorithm: TERMINAL_REPLICA_HASH_ALGORITHM,
  });
}

export function evaluateStateConvergence(
  expected: StateConvergenceIdentityV1,
  observations: readonly ClientConvergenceObservationV1[],
): StateConvergenceEvaluation {
  expected = StateConvergenceIdentityV1SchemaZ.parse(expected);
  const parsed = observations.map((observation) =>
    ClientConvergenceObservationV1SchemaZ.parse(observation),
  );
  assertUnique(
    parsed.map(({ clientId }) => clientId),
    "client observation",
  );
  const healthy = parsed.filter(({ disposition }) => disposition === "healthy");
  const matchingClientIds = healthy
    .filter(({ identity }) => identitiesEqual(identity, expected))
    .map(({ clientId }) => clientId)
    .sort();
  const divergentClientIds = healthy
    .filter(({ identity }) => !identitiesEqual(identity, expected))
    .map(({ clientId }) => clientId)
    .sort();
  const excludedClientIds = parsed
    .filter(({ disposition }) => disposition !== "healthy")
    .map(({ clientId }) => clientId)
    .sort();
  return Object.freeze({
    converged: healthy.length > 0 && divergentClientIds.length === 0,
    expected,
    healthyClientCount: healthy.length,
    matchingClientIds: Object.freeze(matchingClientIds),
    divergentClientIds: Object.freeze(divergentClientIds),
    excludedClientIds: Object.freeze(excludedClientIds),
  });
}

export function evaluateQueueBounds(
  metrics: readonly ClientQueueMetricV1[],
): QueueBoundsEvaluation {
  const parsed = metrics.map((metric) => ClientQueueMetricV1SchemaZ.parse(metric));
  if (parsed.length === 0) throw new TypeError("queue evaluation requires metrics");
  return Object.freeze({
    bounded: parsed.every(
      ({ depthItems, capacityItems, bytes, capacityBytes }) =>
        depthItems <= capacityItems && bytes <= capacityBytes,
    ),
    maxDepthItems: Math.max(...parsed.map(({ depthItems }) => depthItems)),
    maxBytes: Math.max(...parsed.map(({ bytes }) => bytes)),
    coalesced: parsed.reduce((sum, { coalesced }) => sum + coalesced, 0),
    dropped: parsed.reduce((sum, { dropped }) => sum + dropped, 0),
  });
}

/** Least-squares slope: bounded capacity alone cannot conceal flood-dependent growth. */
export function evaluateQueuePlateau(
  series: ClientQueueSeriesV1,
  allowedItemSlopePerSample = 0,
  allowedByteSlopePerSample = 0,
): QueuePlateauEvaluation {
  const parsed = ClientQueueSeriesV1SchemaZ.parse(series);
  if (
    !Number.isFinite(allowedItemSlopePerSample) ||
    allowedItemSlopePerSample < 0 ||
    !Number.isFinite(allowedByteSlopePerSample) ||
    allowedByteSlopePerSample < 0
  )
    throw new TypeError("allowed queue slopes must be finite and non-negative");
  const itemSlopePerSample = leastSquaresSlope(
    parsed.map(({ sampleOrdinal }) => sampleOrdinal),
    parsed.map(({ depthItems }) => depthItems),
  );
  const byteSlopePerSample = leastSquaresSlope(
    parsed.map(({ sampleOrdinal }) => sampleOrdinal),
    parsed.map(({ bytes }) => bytes),
  );
  return Object.freeze({
    plateaued:
      itemSlopePerSample <= allowedItemSlopePerSample &&
      byteSlopePerSample <= allowedByteSlopePerSample,
    itemSlopePerSample,
    byteSlopePerSample,
    allowedItemSlopePerSample,
    allowedByteSlopePerSample,
    sampleCount: parsed.length,
  });
}

export function evaluateSlowClientIsolation(
  baselineHealthyTraces: readonly PerformanceTraceV1[],
  contendedHealthyTraces: readonly PerformanceTraceV1[],
  allowedRegressionMs: number,
): SlowClientIsolationEvaluation {
  if (!Number.isFinite(allowedRegressionMs) || allowedRegressionMs < 0)
    throw new TypeError("allowed regression must be finite and non-negative");
  const baselineP95Ms = evaluatePerformanceBudget(baselineHealthyTraces).inputToPaint.p95Ms;
  const contendedP95Ms = evaluatePerformanceBudget(contendedHealthyTraces).inputToPaint.p95Ms;
  const regressionMs = Math.max(0, contendedP95Ms - baselineP95Ms);
  return Object.freeze({
    passed: regressionMs <= allowedRegressionMs,
    baselineP95Ms,
    contendedP95Ms,
    regressionMs,
    allowedRegressionMs,
  });
}

/** Every accepted mutation must have exactly one explicit terminal outcome. */
export function evaluateMutationOutcomes(
  acceptances: readonly MutationQualificationAcceptanceV1[],
  outcomes: readonly MutationTerminalOutcomeV1[],
): MutationOutcomeEvaluation {
  const parsedAcceptances = acceptances.map((acceptance) =>
    MutationQualificationAcceptanceV1SchemaZ.parse(acceptance),
  );
  const parsedOutcomes = outcomes.map((outcome) => MutationTerminalOutcomeV1SchemaZ.parse(outcome));
  assertUnique(
    parsedAcceptances.map(({ mutationId }) => mutationId),
    "accepted mutation",
  );
  const accepted = new Map(parsedAcceptances.map((value) => [value.mutationId, value]));
  const counts = new Map<string, number>();
  for (const { mutationId } of parsedOutcomes)
    counts.set(mutationId, (counts.get(mutationId) ?? 0) + 1);
  const limboMutationIds = [...accepted.keys()]
    .filter((mutationId) => !counts.has(mutationId))
    .sort();
  const duplicateMutationIds = [...counts]
    .filter(([, count]) => count > 1)
    .map(([mutationId]) => mutationId)
    .sort();
  const unknownMutationIds = [...counts.keys()]
    .filter((mutationId) => !accepted.has(mutationId))
    .sort();
  const clockDomainMismatchMutationIds = new Set<string>();
  const earlyMutationIds = new Set<string>();
  const lateMutationIds = new Set<string>();
  const prematureTimeoutMutationIds = new Set<string>();
  for (const outcome of parsedOutcomes) {
    const acceptance = accepted.get(outcome.mutationId);
    if (!acceptance) continue;
    if (
      outcome.processId !== acceptance.processId ||
      outcome.clockId !== acceptance.clockId ||
      outcome.clockKind !== acceptance.clockKind
    ) {
      clockDomainMismatchMutationIds.add(outcome.mutationId);
      continue;
    }
    if (outcome.occurredAtMicros < acceptance.acceptedAtMicros)
      earlyMutationIds.add(outcome.mutationId);
    if (outcome.status !== "timed-out" && outcome.occurredAtMicros > acceptance.deadlineAtMicros)
      lateMutationIds.add(outcome.mutationId);
    if (outcome.status === "timed-out" && outcome.occurredAtMicros < acceptance.deadlineAtMicros)
      prematureTimeoutMutationIds.add(outcome.mutationId);
  }
  const clockDomainMismatches = [...clockDomainMismatchMutationIds].sort();
  const early = [...earlyMutationIds].sort();
  const late = [...lateMutationIds].sort();
  const prematureTimeouts = [...prematureTimeoutMutationIds].sort();
  return Object.freeze({
    complete:
      limboMutationIds.length === 0 &&
      duplicateMutationIds.length === 0 &&
      unknownMutationIds.length === 0 &&
      clockDomainMismatches.length === 0 &&
      early.length === 0 &&
      late.length === 0 &&
      prematureTimeouts.length === 0,
    acceptedCount: parsedAcceptances.length,
    terminalCount: parsedOutcomes.length,
    limboMutationIds: Object.freeze(limboMutationIds),
    duplicateMutationIds: Object.freeze(duplicateMutationIds),
    unknownMutationIds: Object.freeze(unknownMutationIds),
    clockDomainMismatchMutationIds: Object.freeze(clockDomainMismatches),
    earlyMutationIds: Object.freeze(early),
    lateMutationIds: Object.freeze(late),
    prematureTimeoutMutationIds: Object.freeze(prematureTimeouts),
  });
}

function identitiesEqual(
  left: StateConvergenceIdentityV1,
  right: StateConvergenceIdentityV1,
): boolean {
  return (
    left.generation === right.generation &&
    left.incarnation === right.incarnation &&
    left.revision === right.revision &&
    left.stateHash === right.stateHash &&
    left.hashAlgorithm === right.hashAlgorithm
  );
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length)
    throw new TypeError(`${label} identities must be unique`);
}

function leastSquaresSlope(x: readonly number[], y: readonly number[]): number {
  const meanX = x.reduce((sum, value) => sum + value, 0) / x.length;
  const meanY = y.reduce((sum, value) => sum + value, 0) / y.length;
  let covariance = 0;
  let variance = 0;
  for (let index = 0; index < x.length; index += 1) {
    covariance += (x[index]! - meanX) * (y[index]! - meanY);
    variance += (x[index]! - meanX) ** 2;
  }
  return variance === 0 ? 0 : covariance / variance;
}
