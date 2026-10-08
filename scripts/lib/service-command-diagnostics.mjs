const OUTPUT_LIMIT = 16 * 1024;

// Service qualification uses a private environment. Never serialize that
// environment, and redact credential-shaped output before bounding the tails.
function outputTail(value) {
  const text = String(value ?? "")
    .replace(/(bearer\s+)[^\s"']+/giu, "$1[REDACTED]")
    .replace(
      /((?:password|token|secret|authorization|cookie|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;}]+/giu,
      "$1[REDACTED]",
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, "$1[REDACTED]@");
  const bytes = Buffer.from(text);
  let start = Math.max(0, bytes.length - OUTPUT_LIMIT);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return {
    text: bytes.subarray(start).toString("utf8"),
    bytes: bytes.length,
    truncated: start > 0,
  };
}

export function serviceCommandFailure(command, result) {
  return {
    command,
    exitCode: result.status,
    signal: result.signal,
    errorCode: result.error?.code ?? null,
    stdout: outputTail(result.stdout),
    stderr: outputTail(result.stderr),
  };
}
