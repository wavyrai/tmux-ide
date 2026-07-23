import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Pure helpers shared by the daemon's ticket-redeeming WebSocket admission
 * boundaries (direct terminal attachments and pane streams). Extracted
 * verbatim from the reviewed direct-websocket admission so both endpoints
 * keep one Origin canonicalization, one strict-UTF-8 JSON gate, and one
 * constant-time ticket digest discipline.
 */
const WS_OPEN = 1;

export interface CloseableSocket {
  readonly readyState: number;
  close(code?: number, reason?: string): void;
}

/** Canonical renderer Origin, or null for every invalid shape. */
export function canonicalOriginOrNull(value: string): string | null {
  if (
    typeof value !== "string" ||
    value.length < 4 ||
    value.length > 2048 ||
    value === "null" ||
    value === "*" ||
    /[\0\r\n\t ]/u.test(value)
  ) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    !/^[a-z][a-z0-9+.-]*:$/u.test(parsed.protocol) ||
    parsed.protocol === "file:" ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search ||
    parsed.hash ||
    !parsed.hostname
  ) {
    return null;
  }
  const canonical = `${parsed.protocol}//${parsed.host}`;
  return canonical === value ? canonical : null;
}

export function rawDataToBuffer(data: string | Buffer | ArrayBuffer | readonly Buffer[]): Buffer {
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.concat(data.map((entry) => Buffer.from(entry)));
}

/** Byte length with an early exit: anything past `maximum` reports maximum+1. */
export function rawDataByteLength(
  data: string | Buffer | ArrayBuffer | readonly Buffer[],
  maximum: number,
): number {
  if (typeof data === "string") return Buffer.byteLength(data, "utf8");
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  let total = 0;
  for (const entry of data) {
    if (entry.byteLength > maximum - total) return maximum + 1;
    total += entry.byteLength;
  }
  return total;
}

/** Strict UTF-8 JSON: replacement characters and mixed encodings are rejected. */
export function strictJsonParse(bytes: Buffer): unknown {
  const text = bytes.toString("utf8");
  if (Buffer.byteLength(text, "utf8") !== bytes.byteLength || text.includes("\uFFFD")) {
    throw new TypeError("Control frame is not valid UTF-8.");
  }
  return JSON.parse(text) as unknown;
}

export function safeCloseSocket(socket: CloseableSocket, code: number, reason: string): void {
  try {
    if (socket.readyState === WS_OPEN) socket.close(code, reason.slice(0, 123));
  } catch {
    // Teardown ownership has already moved to the daemon state machine.
  }
}

export function digestSecret(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

export function digestsEqual(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
