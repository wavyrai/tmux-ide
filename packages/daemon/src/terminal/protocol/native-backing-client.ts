import { decodeNativeGridCapture, type NativeGridCapture } from "../mirror/native-grid-capture.ts";

export interface NativeBackingIdentity {
  generation: string;
  incarnation: string;
  revision: number;
  stateHash: string;
}
export type ReadNativeBacking = (
  paneId: string,
  expected: NativeBackingIdentity,
  signal: AbortSignal,
) => Promise<NativeGridCapture | null>;

/** One bounded read on entering scrollback. No captures are issued by wheel movement. */
export async function readNativeBacking(options: {
  baseUrl: string;
  ownerToken: string;
  workspaceName: string;
  paneId: string;
  expected: NativeBackingIdentity;
  signal: AbortSignal;
}): Promise<NativeGridCapture | null> {
  const url = new URL(
    `/api/project/${encodeURIComponent(options.workspaceName)}/terminal-native-backing/${encodeURIComponent(options.paneId)}`,
    options.baseUrl,
  );
  for (const [key, value] of Object.entries(options.expected))
    url.searchParams.set(key, String(value));
  const response = await fetch(url, {
    redirect: "error",
    headers: { Authorization: `Bearer ${options.ownerToken}` },
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(5500)]),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 16 * 1024 * 1024 + 4096) return null;
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const end = text.indexOf("\n");
    if (end < 0 || end > 4096) return null;
    const authority = JSON.parse(text.slice(0, end));
    if (
      authority.workspaceName !== options.workspaceName ||
      authority.semanticPaneId !== options.paneId ||
      Object.entries(options.expected).some(([key, value]) => authority[key] !== value)
    )
      return null;
    return decodeNativeGridCapture(text.slice(end + 1));
  } finally {
    await reader.cancel();
  }
}
