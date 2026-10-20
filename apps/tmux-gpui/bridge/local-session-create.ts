import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  getCanonicalDaemonInfoPath,
  inspectCanonicalDaemonInfoPath,
  canonicalDaemonUrl,
} from "../../../packages/daemon/src/lib/canonical-daemon.ts";
import { listTmuxServers } from "../../../packages/daemon-client/src/tmux-server-client.ts";
import { dispatchOwnerAction } from "../../../packages/daemon-client/src/owner-action-client.ts";
import {
  WorkspaceSessionCreateArgumentsSchemaZ,
  type WorkspaceSessionCreateResult,
} from "../../../packages/contracts/src/fleet-lifecycle.ts";
import { discoverPreviewDaemon } from "./discovery.ts";

export type LocalSessionCreateProof = Readonly<{ action: string }>;
type Context = { current: () => boolean; signal?: AbortSignal };
type PrivateProof = {
  path: string;
  fingerprint: string;
  request: typeof fetch;
  consumed: boolean;
};
const proofs = new WeakMap<LocalSessionCreateProof, PrivateProof>();
const principal = `gpui-local-create:${randomUUID()}`;
const MAX_BODY = 256 * 1024;

/** Bound both fetch and body reads, including injected transports which ignore AbortSignal. */
async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => {});
    signal.throwIfAborted();
  }
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new Error("Stopped waiting"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
function transport(request: typeof fetch, context: Context, signal: AbortSignal): typeof fetch {
  return async (url, init) => {
    if (!context.current()) throw new Error("Target changed");
    const combined = AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]);
    combined.throwIfAborted();
    const response = await bounded(
      request(url, { ...init, signal: combined, redirect: "error" }).then((response) => {
        if (combined.aborted) {
          void response.body?.cancel().catch(() => {});
          throw new Error("Stopped waiting");
        }
        return response;
      }),
      combined,
    );
    if (!response.ok || response.redirected) {
      void response.body?.cancel().catch(() => {});
      throw new Error("Request unavailable");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing body");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const item = await bounded(reader.read(), combined);
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > MAX_BODY) throw new Error("Response too large");
        chunks.push(item.value);
      }
    } finally {
      void reader.cancel().catch(() => {});
    }
    if (!context.current()) throw new Error("Target changed");
    combined.throwIfAborted();
    return new Response(Buffer.concat(chunks), { status: response.status });
  };
}
async function verify(path: string, request: typeof fetch, expected?: string) {
  const info = await discoverPreviewDaemon(path, request);
  const fingerprint = JSON.stringify(info);
  if (expected !== undefined && fingerprint !== expected) throw new Error("Owner changed");
  const { servers } = await listTmuxServers({
    baseUrl: canonicalDaemonUrl("http", info.bindHostname, info.port),
    ownerToken: info.authToken!,
    hostClientId: principal,
    origin: "tmux-ide://app",
    fetch: request,
  });
  if (servers.some((server) => server.state === "online"))
    throw new Error("Server already available");
  const record = inspectCanonicalDaemonInfoPath(path);
  if (record.status !== "valid" || JSON.stringify(record.info) !== fingerprint)
    throw new Error("Record changed");
  return { info, fingerprint };
}

/** Read-only proof. Caller must restrict this to current foreground local Home. */
export async function proveLocalSessionCreate(
  options: Context & { path?: string; fetch?: typeof fetch },
): Promise<
  | { kind: "available"; proof: LocalSessionCreateProof }
  | { kind: "unavailable" | "stopped-waiting" }
> {
  const signal = AbortSignal.any([
    options.signal ?? new AbortController().signal,
    AbortSignal.timeout(8000),
  ]);
  try {
    const path = options.path ?? getCanonicalDaemonInfoPath();
    const request = options.fetch ?? fetch;
    const verified = await verify(path, transport(request, options, signal));
    if (!options.current()) return { kind: "unavailable" };
    signal.throwIfAborted();
    const proof = Object.freeze({ action: randomUUID() });
    proofs.set(proof, { path, fingerprint: verified.fingerprint, request, consumed: false });
    return { kind: "available", proof };
  } catch {
    return { kind: signal.aborted ? "stopped-waiting" : "unavailable" };
  }
}
export type LocalSessionCreateResult =
  | { kind: "created"; receipt: WorkspaceSessionCreateResult }
  | { kind: "unavailable" | "unconfirmed" | "stopped-waiting" | "invalid-name" };

/** Explicit create only; no CLI, tmux process, retries or guessed server scope. */
export async function createLocalSession(
  proof: LocalSessionCreateProof,
  input: { displayName: string },
  context: Context,
): Promise<LocalSessionCreateResult> {
  const parsed = WorkspaceSessionCreateArgumentsSchemaZ.pick({ displayName: true })
    .strict()
    .safeParse(input);
  if (!parsed.success) return { kind: "invalid-name" };
  const owner = proofs.get(proof);
  if (!owner || owner.consumed || !context.current()) return { kind: "unavailable" };
  // Claim before awaits: duplicate invocations cannot both pass the preflight.
  owner.consumed = true;
  const signal = AbortSignal.any([
    context.signal ?? new AbortController().signal,
    AbortSignal.timeout(15000),
  ]);
  let submitted = false;
  try {
    const request = transport(owner.request, context, signal);
    const { info } = await verify(owner.path, request, owner.fingerprint);
    if (!context.current()) return { kind: "unavailable" };
    signal.throwIfAborted();
    const operationId = randomUUID();
    submitted = true;
    const receipt = await dispatchOwnerAction({
      baseUrl: canonicalDaemonUrl("http", info.bindHostname, info.port),
      ownerToken: info.authToken!,
      hostClientId: principal,
      name: "workspace.session.create",
      operationId,
      maximumAttempts: 1,
      timeoutMs: 10000,
      input: {
        displayName: parsed.data.displayName,
        includeLiveSessionId: true,
        expectedDaemonInstanceId: info.instanceId,
      },
      fetch: request,
    });
    if (signal.aborted) return { kind: "stopped-waiting" };
    if (!context.current()) return { kind: "unconfirmed" };
    const record = inspectCanonicalDaemonInfoPath(owner.path);
    if (
      record.status !== "valid" ||
      JSON.stringify(record.info) !== owner.fingerprint ||
      !receipt ||
      receipt.operationId !== operationId ||
      receipt.daemonInstanceId !== info.instanceId
    )
      return { kind: "unconfirmed" };
    return { kind: "created", receipt };
  } catch {
    return { kind: signal.aborted ? "stopped-waiting" : submitted ? "unconfirmed" : "unavailable" };
  }
}

/** Post-create rediscovery fence: the same owner may now legitimately have online servers. */
export async function verifyLocalSessionCreateOwner(
  proof: LocalSessionCreateProof,
  context: Context,
): Promise<boolean> {
  const owner = proofs.get(proof);
  if (!owner || !context.current()) return false;
  const signal = AbortSignal.any([
    context.signal ?? new AbortController().signal,
    AbortSignal.timeout(5000),
  ]);
  try {
    const info = await discoverPreviewDaemon(owner.path, transport(owner.request, context, signal));
    return !signal.aborted && context.current() && JSON.stringify(info) === owner.fingerprint;
  } catch {
    return false;
  }
}
