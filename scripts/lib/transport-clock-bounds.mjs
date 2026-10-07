// Shared arithmetic only; callers must admit identities and calibration separately.
export function clockBounds(clientStage, daemonMicros, direction = "client-to-daemon") {
  if (
    !Number.isSafeInteger(clientStage?.sharedMicros) ||
    !Number.isSafeInteger(daemonMicros) ||
    !Number.isSafeInteger(clientStage?.clockOffsetLowerMicros) ||
    !Number.isSafeInteger(clientStage?.clockOffsetUpperMicros)
  )
    return null;
  const rawLower =
    direction === "client-to-daemon"
      ? daemonMicros - clientStage.sharedMicros - clientStage.clockOffsetUpperMicros
      : clientStage.sharedMicros - daemonMicros + clientStage.clockOffsetLowerMicros;
  const upper =
    direction === "client-to-daemon"
      ? daemonMicros - clientStage.sharedMicros - clientStage.clockOffsetLowerMicros
      : clientStage.sharedMicros - daemonMicros + clientStage.clockOffsetUpperMicros;
  const lower = Math.max(0, rawLower);
  return Number.isSafeInteger(lower) && Number.isSafeInteger(upper) && upper >= lower
    ? Object.freeze({ lowerMicros: lower, upperMicros: upper })
    : null;
}
