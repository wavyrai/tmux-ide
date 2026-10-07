import { assessProductInputSample } from "./product-first-input.mjs";

/** Whole unfiltered prefix; final callers must also admit both closed trace files. */
export function assessReferenceCausalCells(records, daemonRecords, attempts, expected, count = 36) {
  const fail = (reason, detail = {}) => ({ status: "incomplete", reason, ...detail });
  if (!Number.isInteger(count) || count < 1 || count > 36 || attempts.length !== 36)
    return fail("offered-denominator");
  const selected = attempts.slice(0, count);
  const ids = selected.map((a) => a.traceId);
  if (new Set(ids).size !== count || ids.some((id) => typeof id !== "string"))
    return fail("controller-identities");
  const outcomes = records.filter(
    (r) =>
      r.type === "performance.stage" &&
      r.stage === "client" &&
      typeof r.operation === "string" &&
      r.operation.startsWith("causal-cell-"),
  );
  if (
    outcomes.some((r) => !ids.includes(r.traceId) || r.operation.startsWith("causal-cell-failed:"))
  )
    return fail("foreign-or-failed-causal-outcome");
  for (const operation of ["causal-cell-delivered", "causal-cell-painted"])
    if (
      ids.some(
        (id) => outcomes.filter((r) => r.traceId === id && r.operation === operation).length !== 1,
      )
    )
      return fail("causal-outcome-bijection", { operation });
  const origins = records.filter((r) => r.type === "performance.input-origin");
  const inputs = records.filter((r) => r.type === "performance.stage" && r.stage === "input");
  const paints = records.filter(
    (r) => r.type === "performance.stage" && r.stage === "paint" && r.traceId != null,
  );
  const fences = records.filter((r) => r.type === "performance.input-fence");
  for (const [name, group] of Object.entries({ origins, inputs, paints, fences })) {
    if (
      group.length !== count ||
      ids.some((id) => group.filter((r) => r.traceId === id).length !== 1)
    )
      return fail(`${name}-bijection`, { count: group.length, expectedCount: count });
  }
  if (
    daemonRecords.some(
      (r) =>
        r.type === "performance.stage" &&
        (r.processId !== expected.daemonProcessId ||
          r.clockId !== expected.daemonClockId ||
          r.clockKind !== "performance-now" ||
          (r.authority !== null && r.authority?.generation !== expected.generation)),
    )
  )
    return fail("daemon-owner-clock");
  const cell = expected.initialCell;
  if (
    !cell ||
    !Number.isSafeInteger(cell.row) ||
    !Number.isSafeInteger(cell.column) ||
    !Number.isSafeInteger(cell.cols) ||
    !Number.isSafeInteger(cell.rows) ||
    cell.row < 0 ||
    cell.row >= cell.rows ||
    cell.column !== cell.cols - 1 ||
    cell.cols < 2 ||
    typeof cell.grapheme !== "string"
  )
    return fail("native-cell-baseline");
  let beforeGrapheme = cell.grapheme;
  let revision = expected.revision,
    stateHash = expected.stateHash;
  const samples = [];
  for (let ordinal = 0; ordinal < count; ordinal++) {
    const attempt = selected[ordinal];
    if (
      attempt.ordinal !== ordinal ||
      attempt.status !== "matched" ||
      !["x", "y"].includes(attempt.payload)
    )
      return fail("controller-outcome", { ordinal });
    const origin = origins.find((r) => r.traceId === attempt.traceId);
    const assessment = assessProductInputSample(
      records,
      origin,
      {
        ...expected,
        revision,
        stateHash,
        variant: "key",
        requireDaemonEvidence: true,
        requireSharedClockEvidence: true,
        daemonTraceRecords: daemonRecords,
      },
      Buffer.from(attempt.payload, "ascii"),
    );
    if (!assessment.qualified) return fail("full-causal-predicate", { ordinal, assessment });
    const { sample } = assessment.qualified;
    for (const operation of ["causal-cell-delivered", "causal-cell-painted"]) {
      const proof = outcomes.find(
        (r) => r.traceId === attempt.traceId && r.operation === operation,
      );
      if (
        proof.causalAttribution !== true ||
        proof.row !== cell.row ||
        proof.column !== cell.column ||
        proof.beforeGrapheme !== beforeGrapheme ||
        proof.afterGrapheme !== attempt.payload ||
        proof.beforeGrapheme === proof.afterGrapheme ||
        proof.revision !== sample.revision ||
        proof.stateHash !== sample.stateHash ||
        proof.semanticPaneId !== expected.semanticPaneId ||
        proof.generation !== expected.generation ||
        proof.incarnation !== expected.incarnation
      )
        return fail("declared-cell-proof", { ordinal, operation });
    }
    beforeGrapheme = attempt.payload;
    samples.push({
      ordinal,
      traceId: attempt.traceId,
      baselineRevision: revision,
      baselineStateHash: stateHash,
      committedRevision: sample.revision,
      committedStateHash: sample.stateHash,
      predicates: assessment.predicates,
    });
    revision = sample.revision;
    stateHash = sample.stateHash;
  }
  return {
    status: count === 36 ? "complete" : "prefix-complete",
    observed: count,
    samples,
    scope:
      "Existing full causal-cell predicates; distinct fixed-cell workload, not complete mission/native or terminal-output timing acceptance",
  };
}
