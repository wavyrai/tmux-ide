import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { connect } from "node:net";
import {
  NativeBrowserCommandSchemaZ,
  NativeBrowserStateSchemaZ,
  type NativeBrowserCommand,
  type NativeBrowserState,
} from "@tmux-ide/contracts";
import { z } from "zod";

export const NativeBrowserEndpointSchema = z
  .object({
    version: z.literal(1),
    pid: z.number().int().positive(),
    instance: z.uuid(),
    pane: z
      .string()
      .regex(/^%[0-9]+$/u)
      .max(32),
    socket: z.string().min(1).max(1024).refine(isAbsolute),
  })
  .strict();
export type NativeBrowserEndpoint = z.infer<typeof NativeBrowserEndpointSchema>;
export class NativeBrowserUnavailable extends Error {
  constructor() {
    super("Native browser controls are unavailable");
  }
}
const responseSchema = z.discriminatedUnion("ok", [
  z
    .object({ id: z.string(), ok: z.literal(true), data: NativeBrowserStateSchemaZ.nullable() })
    .strict(),
  z.object({ id: z.string(), ok: z.literal(false), error: z.string().max(4096) }).strict(),
]);

/** One request, one bounded response. Mutations are never retried or refreshed. */
export async function nativeBrowserRpc(
  endpoint: NativeBrowserEndpoint,
  command: NativeBrowserCommand | null,
  signal: AbortSignal,
): Promise<NativeBrowserState | null> {
  const target = NativeBrowserEndpointSchema.parse(endpoint);
  const payload = command ? NativeBrowserCommandSchemaZ.parse(command) : null;
  if (payload && (payload.instance !== target.instance || payload.pane !== target.pane))
    throw new NativeBrowserUnavailable();
  signal.throwIfAborted();
  const info = await lstat(target.socket);
  if (!info.isSocket() || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0)
    throw new NativeBrowserUnavailable();
  try {
    process.kill(target.pid, 0);
  } catch {
    throw new NativeBrowserUnavailable();
  }
  signal.throwIfAborted();
  const id = randomUUID();
  const request =
    JSON.stringify({
      id,
      cmd: payload ? "native/1/command" : "native/1/state",
      ...(payload ? { payload } : {}),
    }) + "\n";
  return new Promise((resolve, reject) => {
    const socket = connect(target.socket);
    let finished = false;
    let size = 0;
    const chunks: Buffer[] = [];
    const finish = (error?: Error, state: NativeBrowserState | null = null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error);
      else resolve(state);
    };
    const abort = () => finish(new NativeBrowserUnavailable());
    const timer = setTimeout(abort, 1500);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    socket.once("connect", () => socket.write(request));
    socket.on("error", abort);
    socket.once("end", () => {
      if (!finished) abort();
    });
    socket.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 128 * 1024) {
        abort();
        return;
      }
      chunks.push(chunk);
      if (!chunk.includes(10)) return;
      try {
        const bytes = Buffer.concat(chunks);
        const newline = bytes.indexOf(10);
        if (newline !== bytes.length - 1) throw new NativeBrowserUnavailable();
        const reply = responseSchema.parse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, newline))),
        );
        if (reply.id !== id || !reply.ok) throw new NativeBrowserUnavailable();
        if (
          reply.data &&
          (reply.data.instance !== target.instance || reply.data.pane !== target.pane)
        )
          throw new NativeBrowserUnavailable();
        finish(undefined, reply.data);
      } catch {
        abort();
      }
    });
  });
}
