import { spawn as spawnPty } from "node-pty";

const [, , socketPath, session, rawCols, rawRows] = process.argv;
if (!socketPath || !session) {
  throw new Error("socket path and session are required");
}

const cols = Number(rawCols);
const rows = Number(rawRows);
if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
  throw new Error("valid PTY geometry is required");
}

const externalClientEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) => value !== undefined && key !== "TMUX" && key !== "TMUX_PANE",
  ),
);
const client = spawnPty("tmux", ["-S", socketPath, "attach-session", "-t", `=${session}`], {
  cols,
  rows,
  cwd: process.cwd(),
  env: { ...externalClientEnv, TERM: "xterm-256color" },
});

process.stdout.write(`${JSON.stringify({ ptyPid: client.pid })}\n`);
client.onData(() => undefined);
client.onExit(({ exitCode, signal }) => {
  process.stderr.write(`${JSON.stringify({ event: "pty-exit", exitCode, signal })}\n`);
  process.exit(exitCode || (signal ? 1 : 0));
});

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  try {
    client.kill("SIGTERM");
  } catch {
    process.exit(0);
  }
}

process.on("SIGTERM", stop);
process.on("SIGINT", stop);
