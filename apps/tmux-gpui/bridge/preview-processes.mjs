import { spawn } from "node:child_process";

// Own only these two children. In particular, never signal the daemon or tmux.
export async function runPreview({ helper, native, signal, graceMs = 1500, duplex = false }) {
  const children = [];
  const waits = [];
  let stopping = false;
  let failed = false;
  let escalation;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }
    escalation = setTimeout(() => {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    }, graceMs);
  };
  const start = (spec, stdio) => {
    const child = spawn(spec.command, spec.args, { stdio, env: spec.env ?? process.env });
    children.push(child);
    waits.push(
      new Promise((resolve) => {
        child.once("error", () => {
          failed = true;
          stop();
        });
        child.once("close", (code) => resolve(code));
      }),
    );
    return child;
  };
  if (signal?.aborted) return 1;
  signal?.addEventListener("abort", stop, { once: true });
  try {
    const viewer = start(native, ["pipe", duplex ? "pipe" : "inherit", "inherit"]);
    const source = start(helper, [duplex ? "pipe" : "ignore", "pipe", "inherit"]);
    // The viewer can close while the helper is idle: EOF/EPIPE alone cannot
    // notify an idle producer. The owner must explicitly terminate and reap it.
    viewer.once("exit", stop);
    viewer.stdin.on("error", () => stop());
    source.stdout.pipe(viewer.stdin);
    if (duplex) {
      source.stdin.on("error", () => stop());
      viewer.stdout.pipe(source.stdin);
    }
    const [viewerCode, helperCode] = await Promise.all(waits);
    return failed || signal?.aborted ? 1 : (viewerCode ?? 1) || (helperCode ?? (stopping ? 0 : 1));
  } finally {
    clearTimeout(escalation);
    signal?.removeEventListener("abort", stop);
  }
}
