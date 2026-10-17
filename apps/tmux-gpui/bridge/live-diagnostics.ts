import { PaneStreamOperationError } from "../../../packages/daemon-client/src/pane-stream-client.ts";
const PREFIX = "TMUX_GPUI_DIAGNOSTIC ";
const MAX_DIAGNOSTIC_BYTES = 256;
const STATUSES = {
  "publication-limit": "Terminal display exceeded the safe publication limit",
  "replica-validation": "Terminal state validation failed",
  "source-state-limit": "Terminal source exceeded its safe state limit",
  "source-closed": "Terminal source closed",
  "source-protocol": "Terminal source reported a protocol failure",
  "transport-closed": "Terminal connection closed",
  "topology-changed": "Terminal layout changed — reconnecting",
  "transport-error": "Terminal transport failed",
  startup: "Terminal connection could not start",
  "runtime-failure": "Terminal connection validation or operation failed",
} as const;
export type LiveDiagnostic = {
  code: keyof typeof STATUSES;
  closeCode?: number;
};

// Child stderr is untrusted. Accept only this small vocabulary, never error
// messages, close reasons, URLs, identifiers, or terminal data.
export function parseDiagnosticLine(line: string): LiveDiagnostic | null {
  if (Buffer.byteLength(line) > MAX_DIAGNOSTIC_BYTES || !line.startsWith(PREFIX)) return null;
  try {
    const value: unknown = JSON.parse(line.slice(PREFIX.length));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const fields = value as Record<string, unknown>;
    if (
      typeof fields.code !== "string" ||
      !Object.hasOwn(STATUSES, fields.code) ||
      Object.keys(fields).some((key) => key !== "code" && key !== "closeCode") ||
      (Object.hasOwn(fields, "closeCode") &&
        (fields.code !== "transport-closed" ||
          !Number.isSafeInteger(fields.closeCode) ||
          (fields.closeCode as number) < 1000 ||
          (fields.closeCode as number) > 4999))
    )
      return null;
    return {
      code: fields.code as LiveDiagnostic["code"],
      ...(Object.hasOwn(fields, "closeCode") ? { closeCode: fields.closeCode as number } : {}),
    };
  } catch {
    return null;
  }
}

export function diagnosticStatus(diagnostic: LiveDiagnostic): string {
  return (
    STATUSES[diagnostic.code] +
    (diagnostic.closeCode === undefined ? "" : ` (code ${diagnostic.closeCode})`)
  );
}

export function createLiveDiagnostics(write: (line: string) => void) {
  let reported = false;
  const report = (code: LiveDiagnostic["code"], closeCode?: unknown) => {
    if (reported) return;
    reported = true;
    const diagnostic: LiveDiagnostic = {
      code,
      ...(code === "transport-closed" &&
      Number.isSafeInteger(closeCode) &&
      (closeCode as number) >= 1000 &&
      (closeCode as number) <= 4999
        ? { closeCode: closeCode as number }
        : {}),
    };
    try {
      write(PREFIX + JSON.stringify(diagnostic) + "\n");
    } catch {
      // Observability must not interrupt retirement or change the failure.
    }
  };
  return {
    report,
    runtimeFault(error: unknown) {
      report(
        error instanceof PaneStreamOperationError && error.code === "topology-changed"
          ? "topology-changed"
          : "runtime-failure",
      );
    },
    sourceFault(reason: unknown) {
      report(
        reason === "state-too-large"
          ? "source-state-limit"
          : reason === "source-closed"
            ? "source-closed"
            : "source-protocol",
      );
    },
    publication(line: string) {
      if (Buffer.byteLength(line) <= 8 * 1024 * 1024) return;
      report("publication-limit");
      throw new Error("Preview frame too large");
    },
  };
}
