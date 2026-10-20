/** Read only a fixed refusal code; never retain server messages or private context. */
export async function readPaneCreationRefusal(
  response: Response,
  signal: AbortSignal,
): Promise<"harness_unavailable" | undefined> {
  if (response.status !== 409 || !response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 1024) return undefined;
      chunks.push(value);
    }
    signal.throwIfAborted();
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (
      !value ||
      typeof value !== "object" ||
      Object.keys(value).length !== 1 ||
      !("error" in value)
    )
      return undefined;
    const error = value.error;
    return error &&
      typeof error === "object" &&
      Object.keys(error).length === 1 &&
      "code" in error &&
      error.code === "harness_unavailable"
      ? "harness_unavailable"
      : undefined;
  } catch {
    return undefined;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
