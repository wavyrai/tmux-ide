import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createNativeInputGate, MAX_GATE_FRAME } from "./native-input-gate-filter.mjs";

// Only the diagnostic owner supplies these paths; the real bundled helper is unchanged.
const [node, browser, directory] = process.argv.slice(2);
if (!node || !browser || !directory || process.argv.length !== 5)
  throw new Error("Usage: native-input-gate-helper.mjs NODE BROWSER_BUNDLE PRIVATE_GATE_DIR");
const gate = createNativeInputGate();
const child = spawn(node, [browser, "--local"], { stdio: ["pipe", "pipe", "inherit"] });
let failed = false,
  stopping = false,
  escalation,
  blocked = false,
  pending = null;
let buffer = Buffer.alloc(0),
  heldReported = false;
const closed = new Promise((resolve) => {
  child.once("error", () => {
    failed = true;
    stop();
  });
  child.once("close", (code, signal) => resolve({ code, signal }));
});
function stop() {
  if (stopping) return;
  stopping = true;
  gate.clear();
  pending = null;
  process.stdin.unpipe(child.stdin);
  child.stdin.destroy();
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  escalation = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 2000);
}
function emit(line) {
  if (stopping || !line) return;
  if (blocked)
    pending = line; // At most one bounded latest output, never an event backlog.
  else blocked = !process.stdout.write(line);
}
process.stdout.on("drain", () => {
  blocked = false;
  if (pending) {
    const line = pending;
    pending = null;
    emit(line);
  }
});
process.stdout.on("error", () => {
  failed = true;
  stop();
});
child.stdin.on("error", () => {
  if (!stopping) failed = true;
  stop();
});
process.stdin.pipe(child.stdin);
process.stdin.once("end", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.stdout.on("data", (chunk) => {
  if (stopping) return;
  try {
    buffer = Buffer.concat([buffer, chunk]);
    let end;
    while ((end = buffer.indexOf(10)) >= 0) {
      if (end > MAX_GATE_FRAME) throw new Error("Oversized gate line");
      const line = buffer.subarray(0, end).toString("utf8");
      buffer = buffer.subarray(end + 1);
      emit(gate.push(line));
    }
    if (buffer.length > MAX_GATE_FRAME) throw new Error("Oversized unfinished gate line");
    if (gate.readyHeld && !heldReported) {
      heldReported = true;
      writeFileSync(join(directory, "held.json"), JSON.stringify({ held: true, pid: child.pid }), {
        mode: 0o600,
        flag: "wx",
      });
    }
  } catch {
    failed = true;
    process.stderr.write("Diagnostic publication gate rejected input\n");
    stop();
  }
});
const poll = setInterval(() => {
  if (stopping || gate.released || !existsSync(join(directory, "release"))) return;
  try {
    const line = gate.release();
    if (line) {
      emit(line);
      writeFileSync(join(directory, "released.json"), JSON.stringify({ released: true }), {
        mode: 0o600,
        flag: "wx",
      });
    }
  } catch {
    failed = true;
    stop();
  }
}, 25);
try {
  const result = await closed;
  if (buffer.length && !stopping) failed = true;
  process.exitCode = failed || (result.code !== 0 && !stopping) ? 1 : 0;
  writeFileSync(
    join(directory, "helper-cleanup.json"),
    JSON.stringify({ ...result, pid: child.pid, reaped: true, failed }),
    { mode: 0o600 },
  );
} finally {
  clearInterval(poll);
  clearTimeout(escalation);
  gate.clear();
  process.stdin.destroy();
}
