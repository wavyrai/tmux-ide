import type { SessionRuntimeTerminalInput } from "@tmux-ide/contracts";

export interface TerminalInputPort {
  /** Changes whenever the physical input authority changes. Never includes its secret token. */
  authority(): string | null;
  send(
    pane: string,
    input: Extract<SessionRuntimeTerminalInput, { kind: "text" | "key" }>,
  ): Promise<"ok" | "authority-lost">;
}
const MAX_QUEUED_BYTES = 64 * 1024;
const FRAME_CHARS = 1024;

/** One ordered, bounded input queue per workspace, shared by every pane. No replay after failure. */
export function createTerminalInputQueue(
  port: TerminalInputPort,
  onError: (reason: string) => void,
) {
  const queue: Array<{ pane: string; text: string; size: number; authority: string }> = [];
  let bytes = 0,
    running = false,
    closed = false,
    revision = 0;
  const reset = () => {
    revision++;
    queue.length = 0;
    bytes = 0;
  };
  const fail = (reason: string) => {
    reset();
    onError(reason);
  };
  async function drain() {
    if (running || closed) return;
    running = true;
    try {
      while (queue.length && !closed) {
        const entry = queue[0]!;
        const epoch = revision;
        if (port.authority() !== entry.authority) {
          fail("Input control changed. Unsent input was discarded.");
          break;
        }
        const data = entry.text;
        let outcome: "ok" | "authority-lost";
        try {
          outcome = await port.send(entry.pane, { kind: "text", data });
        } catch {
          outcome = "authority-lost";
        }
        if (closed || epoch !== revision) break;
        if (outcome !== "ok" || port.authority() !== entry.authority) {
          fail("Input was interrupted. Unsent input was discarded; it will not be replayed.");
          break;
        }
        queue.shift();
        bytes -= entry.size;
      }
    } finally {
      running = false;
      if (queue.length && !closed) void drain();
    }
  }
  return {
    enqueue(pane: string, input: Uint8Array): boolean {
      if (closed || !input.length) return false;
      const authority = port.authority();
      if (!authority) {
        onError("Take input control before typing.");
        return false;
      }
      if (bytes + input.byteLength > MAX_QUEUED_BYTES) {
        fail("Input queue is full. Unsent input was discarded; paste a smaller amount.");
        return false;
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(input);
      } catch {
        onError("This input encoding is not supported by the daemon text channel.");
        return false;
      }
      if (text.includes("\0")) {
        onError("NUL input is not supported by the daemon text channel.");
        return false;
      }
      for (let offset = 0; offset < text.length; ) {
        let end = Math.min(text.length, offset + FRAME_CHARS);
        if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--;
        const chunk = text.slice(offset, end);
        const size = new TextEncoder().encode(chunk).byteLength;
        queue.push({ pane, text: chunk, size, authority });
        bytes += size;
        offset = end;
      }
      void drain();
      return true;
    },
    clear: reset,
    dispose() {
      closed = true;
      reset();
    },
  };
}
