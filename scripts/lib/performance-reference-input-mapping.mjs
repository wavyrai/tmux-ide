import { createHmac } from "node:crypto";

/** A live file may end midway through JSON or UTF-8; never ignore a malformed completed line. */
export function completedReferenceRecords(bytes, final = false) {
  const end = bytes.lastIndexOf(10) + 1;
  if (final && end !== bytes.length) throw new Error("Truncated final input trace");
  if (!end) return [];
  return new TextDecoder("utf-8", { fatal: true })
    .decode(bytes.subarray(0, end))
    .slice(0, -1)
    .split("\n")
    .map(JSON.parse);
}

/** Sequential private-fixture mapping only: payload HMAC does not encode an offer ordinal. */
export function matchReferenceControllerInput(
  events,
  { baseline, originEnd = events.length, payload, key, usedTraceIds = [] },
) {
  if (
    !Number.isSafeInteger(baseline) ||
    baseline < 0 ||
    baseline > events.length ||
    !Number.isSafeInteger(originEnd) ||
    originEnd < baseline ||
    originEnd > events.length
  )
    throw new Error("Invalid controller record fence");
  const origins = events
    .slice(baseline, originEnd)
    .filter((e) => e?.type === "performance.input-origin");
  if (!origins.length) return null;
  if (origins.length !== 1) throw new Error("Ambiguous extra input origins");
  const origin = origins[0];
  if (
    typeof origin.traceId !== "string" ||
    !origin.traceId ||
    usedTraceIds.includes(origin.traceId)
  )
    throw new Error("Duplicate controller input identity");
  const header = events[0];
  if (
    header?.type !== "performance.trace.header" ||
    origin.processId !== header.processId ||
    origin.clockId !== header.clockId ||
    origin.clockKind !== "performance-now" ||
    header.clockKind !== origin.clockKind ||
    typeof origin.processId !== "string" ||
    !origin.processId ||
    typeof origin.clockId !== "string" ||
    !origin.clockId
  )
    throw new Error("Origin collector identity mismatch");
  const fingerprint = createHmac("sha256", key)
    .update(origin.traceId)
    .update("\0")
    .update(Buffer.from(payload))
    .digest("hex");
  if (
    origin.origin !== "keyboard" ||
    origin.parserConsumption !== "keyboard-event" ||
    origin.payloadByteCount !== Buffer.byteLength(payload) ||
    origin.payloadFingerprint !== fingerprint
  )
    throw new Error("Offered payload does not match input origin");
  if (
    events.filter((e) => e?.type === "performance.input-origin" && e.traceId === origin.traceId)
      .length !== 1
  )
    throw new Error("Duplicate origin identity");
  const spans = events.filter(
    (e) => e?.type === "performance.stage" && e.traceId === origin.traceId,
  );
  const inputs = spans.filter((e) => e.stage === "input"),
    paints = spans.filter((e) => e.stage === "paint");
  if (inputs.length > 1 || paints.length > 1)
    throw new Error("Duplicate controller input/paint pair");
  if (!inputs.length || !paints.length) return null;
  const input = inputs[0],
    paint = paints[0];
  if (
    !(
      events.indexOf(origin) < events.indexOf(input) &&
      events.indexOf(input) < events.indexOf(paint)
    )
  )
    throw new Error("Reordered origin/input/paint");
  for (const span of [input, paint])
    if (
      span.processId !== origin.processId ||
      span.clockId !== origin.clockId ||
      span.clockKind !== origin.clockKind ||
      !Number.isSafeInteger(span.startedAtMicros) ||
      !Number.isSafeInteger(span.endedAtMicros) ||
      span.startedAtMicros < 0 ||
      span.endedAtMicros < span.startedAtMicros
    )
      throw new Error("Input mapping clock mismatch");
  if (
    !Number.isSafeInteger(origin.atMicros) ||
    origin.atMicros < 0 ||
    origin.atMicros > input.startedAtMicros ||
    input.endedAtMicros > paint.startedAtMicros ||
    paint.semanticPaneId !== origin.semanticPaneId ||
    paint.generation !== origin.generation ||
    paint.incarnation !== origin.incarnation ||
    !origin.semanticPaneId ||
    !origin.generation ||
    !origin.incarnation ||
    input.authority?.generation !== origin.generation ||
    input.authority?.incarnation !== origin.incarnation
  )
    throw new Error("Input mapping authority or ordering mismatch");
  return {
    traceId: origin.traceId,
    semanticPaneId: origin.semanticPaneId,
    generation: origin.generation,
    incarnation: origin.incarnation,
  };
}

/** No startup or between-offer input is silently included in controller-labelled samples. */
export function reconcileReferenceControllerInputs(events, attempts) {
  const ids = new Set(attempts.map((a) => a.traceId));
  if (
    ids.size !== attempts.length ||
    ids.has(undefined) ||
    attempts.some((a) => a.status !== "matched")
  )
    throw new Error("Incomplete controller attempts");
  for (const type of ["origin", "input", "paint"]) {
    const selected = events.filter((e) =>
      type === "origin"
        ? e?.type === "performance.input-origin"
        : e?.type === "performance.stage" && e.stage === type,
    );
    if (
      selected.length !== ids.size ||
      new Set(selected.map((e) => e.traceId)).size !== ids.size ||
      selected.some((e) => !ids.has(e.traceId))
    )
      throw new Error("Captured inputs do not bijectively match controller attempts");
  }
}
