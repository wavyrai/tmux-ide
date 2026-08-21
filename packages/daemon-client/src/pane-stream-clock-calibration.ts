export interface PaneStreamClockProbeSample {
  readonly probe: number;
  readonly clientSendMicros: number;
  readonly daemonReceiveMicros: number;
  readonly daemonSendMicros: number;
  readonly clientReceiveMicros: number;
}

export interface PaneStreamClockCalibration {
  readonly version: 1;
  readonly requestId: string;
  readonly daemonInstanceId: string;
  readonly probe: number;
  readonly calibratedAtMicros: number;
  /** Bounds for daemon shared time minus client shared time. */
  readonly offsetLowerMicros: number;
  readonly offsetUpperMicros: number;
  readonly uncertaintyMicros: number;
  readonly roundTripMicros: number;
  readonly daemonWorkMicros: number;
}

export type PaneStreamClockCalibrationReason =
  | "calibrated"
  | "timeout-no-sample"
  | "timeout-retained-sample"
  | "clock-unavailable"
  | "send-failed"
  | "ack-request-mismatch"
  | "ack-generation-mismatch"
  | "ack-probe-mismatch"
  | "ack-client-send-mismatch"
  | "ack-clock-unavailable"
  | "invalid-samples"
  | "connection-closed";

export interface PaneStreamClockCalibrationOutcome {
  readonly version: 1;
  readonly requestId: string;
  readonly daemonInstanceId: string;
  readonly reason: PaneStreamClockCalibrationReason;
  readonly attemptedProbes: number;
  readonly receivedProbes: number;
  readonly validProbes: number;
  readonly selectedProbes: 0 | 1;
  readonly selectedProbe: number | null;
}

function safeMicros(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Selects the narrowest valid NTP interval; it never invents a midpoint. */
export function calibratePaneStreamClocks(
  requestId: string,
  daemonInstanceId: string,
  samples: readonly PaneStreamClockProbeSample[],
): PaneStreamClockCalibration | null {
  let selected: PaneStreamClockCalibration | null = null;
  for (const sample of samples) {
    if (
      !Number.isSafeInteger(sample.probe) ||
      sample.probe < 1 ||
      sample.probe > 5 ||
      !safeMicros(sample.clientSendMicros) ||
      !safeMicros(sample.daemonReceiveMicros) ||
      !safeMicros(sample.daemonSendMicros) ||
      !safeMicros(sample.clientReceiveMicros) ||
      sample.daemonSendMicros < sample.daemonReceiveMicros ||
      sample.clientReceiveMicros < sample.clientSendMicros
    )
      continue;
    const lower = sample.daemonSendMicros - sample.clientReceiveMicros;
    const upper = sample.daemonReceiveMicros - sample.clientSendMicros;
    const uncertainty = upper - lower;
    const roundTrip = sample.clientReceiveMicros - sample.clientSendMicros;
    const daemonWork = sample.daemonSendMicros - sample.daemonReceiveMicros;
    if (
      !Number.isSafeInteger(lower) ||
      !Number.isSafeInteger(upper) ||
      !Number.isSafeInteger(uncertainty) ||
      !Number.isSafeInteger(roundTrip) ||
      !Number.isSafeInteger(daemonWork) ||
      uncertainty < 0
    )
      continue;
    const candidate: PaneStreamClockCalibration = Object.freeze({
      version: 1,
      requestId,
      daemonInstanceId,
      probe: sample.probe,
      calibratedAtMicros: sample.clientReceiveMicros,
      offsetLowerMicros: lower,
      offsetUpperMicros: upper,
      uncertaintyMicros: uncertainty,
      roundTripMicros: roundTrip,
      daemonWorkMicros: daemonWork,
    });
    if (!selected || candidate.uncertaintyMicros < selected.uncertaintyMicros) selected = candidate;
  }
  return selected;
}

export function crossProcessOneWayBounds(
  calibration: PaneStreamClockCalibration,
  clientMicros: number,
  daemonMicros: number,
): { readonly lowerMicros: number; readonly upperMicros: number } | null {
  if (!safeMicros(clientMicros) || !safeMicros(daemonMicros)) return null;
  const lowerMicros = daemonMicros - clientMicros - calibration.offsetUpperMicros;
  const upperMicros = daemonMicros - clientMicros - calibration.offsetLowerMicros;
  const clampedLower = Math.max(0, lowerMicros);
  if (
    !Number.isSafeInteger(clampedLower) ||
    !Number.isSafeInteger(upperMicros) ||
    upperMicros < clampedLower
  )
    return null;
  return Object.freeze({ lowerMicros: clampedLower, upperMicros });
}

export function daemonToClientOneWayBounds(
  calibration: PaneStreamClockCalibration,
  daemonMicros: number,
  clientMicros: number,
): { readonly lowerMicros: number; readonly upperMicros: number } | null {
  if (!safeMicros(clientMicros) || !safeMicros(daemonMicros)) return null;
  const lowerMicros = clientMicros - daemonMicros + calibration.offsetLowerMicros;
  const upperMicros = clientMicros - daemonMicros + calibration.offsetUpperMicros;
  const clampedLower = Math.max(0, lowerMicros);
  if (
    !Number.isSafeInteger(clampedLower) ||
    !Number.isSafeInteger(upperMicros) ||
    upperMicros < clampedLower
  )
    return null;
  return Object.freeze({ lowerMicros: clampedLower, upperMicros });
}

export function qualifyPaneStreamClockCalibration(
  calibration: PaneStreamClockCalibration | null,
  expected: {
    readonly requestId: string;
    readonly daemonInstanceId: string;
    readonly nowMicros: number;
    readonly maxAgeMicros: number;
    readonly maxUncertaintyMicros: number;
  },
): boolean {
  return Boolean(
    calibration &&
    calibration.requestId === expected.requestId &&
    calibration.daemonInstanceId === expected.daemonInstanceId &&
    safeMicros(expected.nowMicros) &&
    safeMicros(expected.maxAgeMicros) &&
    safeMicros(expected.maxUncertaintyMicros) &&
    expected.nowMicros >= calibration.calibratedAtMicros &&
    expected.nowMicros - calibration.calibratedAtMicros <= expected.maxAgeMicros &&
    calibration.uncertaintyMicros <= expected.maxUncertaintyMicros,
  );
}
