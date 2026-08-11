/** Initial tmux window-size authority for a visual client. */

export interface WindowSizeClaim {
  readonly target: string;
  readonly cols: number;
  readonly rows: number;
}

export interface ObservedWindowSize {
  readonly cols: number;
  readonly rows: number;
}

function normalizedDimension(value: number): number {
  return Math.max(1, Math.floor(value));
}

function tmuxQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

/** Commands are pure so the attach handshake and its ordering stay testable. */
export function initialWindowSizeCommands(claim: WindowSizeClaim): readonly string[] {
  const cols = normalizedDimension(claim.cols);
  const rows = normalizedDimension(claim.rows);
  const target = tmuxQuote(claim.target);
  return [
    `refresh-client -C ${cols}x${rows}`,
    `set-window-option -t ${target} window-size manual`,
    `resize-window -t ${target} -x ${cols} -y ${rows}`,
  ];
}

/**
 * The first control-mode snapshot can race tmux's layout recomputation. Keep
 * this decision pure so the attach path can verify its claim without adding a
 * timer to the render loop.
 */
export function windowSizeClaimNeedsCorrection(
  claim: WindowSizeClaim,
  observed: ObservedWindowSize | null,
): boolean {
  if (observed === null) return true;
  return (
    normalizedDimension(claim.cols) !== observed.cols ||
    normalizedDimension(claim.rows) !== observed.rows
  );
}
