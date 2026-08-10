/** Initial tmux window-size authority for a visual client. */

export interface WindowSizeClaim {
  readonly target: string;
  readonly cols: number;
  readonly rows: number;
}

function tmuxQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

/** Commands are pure so the attach handshake and its ordering stay testable. */
export function initialWindowSizeCommands(claim: WindowSizeClaim): readonly string[] {
  const cols = Math.max(1, Math.floor(claim.cols));
  const rows = Math.max(1, Math.floor(claim.rows));
  const target = tmuxQuote(claim.target);
  return [
    `refresh-client -C ${cols}x${rows}`,
    `set-window-option -t ${target} window-size manual`,
    `resize-window -t ${target} -x ${cols} -y ${rows}`,
  ];
}
