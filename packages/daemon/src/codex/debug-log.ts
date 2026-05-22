import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CodexDebugLogEvent {
  direction: "in" | "out";
  payload: unknown;
}

export type CodexDebugLogger = (event: CodexDebugLogEvent) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function createCodexDebugLogger(threadId: string): CodexDebugLogger | undefined {
  if (process.env.TMUX_IDE_CODEX_LOG !== "1") return undefined;
  const dir = join(homedir(), ".tmux-ide", "logs");
  const file = join(dir, "codex-events.ndjson");
  mkdirSync(dir, { recursive: true });

  return (event) => {
    const payload = event.payload;
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      threadId,
      direction: event.direction,
    };
    if (isRecord(payload)) {
      if (typeof payload.method === "string") record.method = payload.method;
      if ("params" in payload) record.params = payload.params;
      if (typeof payload.line === "string") record.raw = payload.line;
      if ("_stderr" in payload && typeof payload.line === "string") record.raw = payload.line;
      if (!("raw" in record) && typeof payload.method !== "string") {
        record.raw = JSON.stringify(payload);
      }
    } else if (typeof payload === "string") {
      record.raw = payload;
    }
    appendFileSync(file, `${JSON.stringify(record)}\n`, "utf-8");
  };
}
