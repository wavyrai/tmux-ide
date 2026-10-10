// Diagnostic-only native publication barrier. Never changes frames or commands.
export const MAX_GATE_FRAME = 8 * 1024 * 1024;
export function createNativeInputGate() {
  let latest = null;
  let released = false;
  let sequence = 0;
  let connection;
  let sourceSequence = -1;
  function encode(value) {
    if (sequence === Number.MAX_SAFE_INTEGER) throw new Error("Gate sequence exhausted");
    const result = JSON.stringify({ ...value, sequence: ++sequence }) + "\n";
    if (Buffer.byteLength(result) > MAX_GATE_FRAME) throw new Error("Gate output oversized");
    return result;
  }
  return {
    push(line) {
      if (Buffer.byteLength(line) > MAX_GATE_FRAME) throw new Error("Gate input oversized");
      const value = JSON.parse(line);
      if (
        !Number.isSafeInteger(value.sequence) ||
        value.sequence <= sourceSequence ||
        typeof value.connection !== "string" ||
        (connection && connection !== value.connection)
      )
        throw new Error("Invalid gate source identity/order");
      connection = value.connection;
      sourceSequence = value.sequence;
      if (released) return encode(value);
      latest = value;
      return encode({
        ...value,
        inputReady: false,
        status: value.snapshot
          ? "DIAGNOSTIC input gate held — click and offer the early command"
          : value.status,
      });
    },
    release() {
      if (released || !latest?.snapshot || latest.inputReady !== true) return null;
      released = true;
      const result = encode(latest);
      latest = null;
      return result;
    },
    get readyHeld() {
      return !released && !!latest?.snapshot && latest.inputReady === true;
    },
    get released() {
      return released;
    },
    clear() {
      latest = null;
    },
  };
}
