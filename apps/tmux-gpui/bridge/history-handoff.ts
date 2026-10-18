import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";
const resultSchema = z
  .object({
    kind: z.literal("history-handoff"),
    intent: z.uuid(),
    state: z.enum(["live", "historical", "restoring", "lost", "unavailable", "unsupported"]),
    token: z.uuid().nullable(),
  })
  .strict();
export type HistoryHandoffResult = Pick<z.infer<typeof resultSchema>, "state" | "token">;
/** Detached helper may finish only its already-issued capture. No display or authority is consumed. */
export function drainHistoryCapture(child: ChildProcess, done: Promise<void>, timeoutMs = 2000) {
  const intent = randomUUID();
  let finish!: (value: HistoryHandoffResult | null) => void;
  let settled = false;
  let buffer = Buffer.alloc(0);
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const result = new Promise<HistoryHandoffResult | null>((resolve) => {
    finish = resolve;
  });
  const settle = (value: HistoryHandoffResult | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    child.stdout?.off("data", data);
    child.stdin?.off("error", failed);
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 500);
    finish(value);
  };
  const data = (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 8 * 1024 * 1024) {
      settle(null);
      return;
    }
    let end;
    while ((end = buffer.indexOf(10)) >= 0) {
      const line = buffer.subarray(0, end).toString("utf8");
      buffer = buffer.subarray(end + 1);
      // The listener may attach midway through an obsolete display frame.
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      const parsed = resultSchema.safeParse(value);
      if (parsed.success && parsed.data.intent === intent) settle(parsed.data);
      if (settled) return;
    }
  };
  const failed = () => settle(null);
  const timer = setTimeout(() => settle(null), timeoutMs);
  child.stdout?.on("data", data);
  void done.then(() => {
    settle(null);
    if (killTimer) clearTimeout(killTimer);
  });
  child.stdin?.on("error", failed);
  if (!child.stdin || child.stdin.destroyed || !child.stdin.writable) settle(null);
  else {
    try {
      child.stdin.write(JSON.stringify({ kind: "history-handoff", intent }) + "\n", (error) => {
        if (error) settle(null);
      });
    } catch {
      settle(null);
    }
  }
  return { result, cancel: () => settle(null) };
}
