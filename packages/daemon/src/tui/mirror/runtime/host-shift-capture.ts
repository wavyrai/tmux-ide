import { closeSync, openSync, writeSync } from "node:fs";

/** XTSHIFTESCAPE is a host request, not pane input or a persistent user setting. */
export function acquireHostShiftCapture(
  environment: NodeJS.ProcessEnv = process.env,
  write: (sequence: string) => void = (sequence) => {
    const fd = openSync("/dev/tty", "w");
    try {
      writeSync(fd, sequence);
    } finally {
      closeSync(fd);
    }
  },
): () => void {
  // A surrounding multiplexer owns the outer terminal protocol. Do not send
  // unqualified passthrough sequences to an unknown terminal through it.
  if (environment.TERM_PROGRAM !== "ghostty" || environment.TMUX) return () => {};
  let active = true;
  const request = (capture: boolean) => {
    try {
      write(capture ? "\u001b[>1s" : "\u001b[>0s");
    } catch {
      // A missing controlling terminal must not prevent startup or cleanup.
    }
  };
  request(true);
  return () => {
    if (!active) return;
    active = false;
    request(false);
  };
}
