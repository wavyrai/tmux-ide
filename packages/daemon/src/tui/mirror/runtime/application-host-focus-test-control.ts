import { createHmac, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";

const HMAC = /^[0-9a-f]{64}$/u;
const GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export type ApplicationHostFocusControlBinding = Readonly<{
  generation: string;
  runtimeSession: string;
  workspaceName: string;
  semanticPaneId: string;
  clientId: string;
  rendererEpoch: number;
  clientGeneration: number;
  bindingEpoch: number;
  processId: string;
  rendererFocused: boolean;
}>;

type HostFocusControlRequest = Readonly<{
  version: 1;
  action: "blur" | "focus";
  nonce: string;
  expected: Omit<ApplicationHostFocusControlBinding, "rendererFocused">;
  authHmac: string;
}>;

const exactKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");

function canonicalRequest(request: Omit<HostFocusControlRequest, "authHmac">): string {
  return JSON.stringify(request);
}

export function createApplicationHostFocusTestControlRequest(
  key: string,
  input: Omit<HostFocusControlRequest, "version" | "authHmac">,
): HostFocusControlRequest {
  if (!HMAC.test(key) || !/^[0-9a-f]{32}$/u.test(input.nonce) || !exactBinding(input.expected))
    throw new TypeError("invalid host-focus test control request");
  const unsigned = Object.freeze({ version: 1 as const, ...input });
  return Object.freeze({
    ...unsigned,
    authHmac: digest(key, "host-focus-control-request", canonicalRequest(unsigned)),
  });
}

function digest(key: string, domain: string, value: string): string {
  return createHmac("sha256", Buffer.from(key, "hex")).update(`${domain}\0${value}`).digest("hex");
}

function exactHmac(left: string, right: string): boolean {
  return (
    HMAC.test(left) && HMAC.test(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right))
  );
}

function exactBinding(value: unknown): value is HostFocusControlRequest["expected"] {
  return (
    exactKeys(value, [
      "generation",
      "runtimeSession",
      "workspaceName",
      "semanticPaneId",
      "clientId",
      "rendererEpoch",
      "clientGeneration",
      "bindingEpoch",
      "processId",
    ]) &&
    GENERATION.test(String(value.generation ?? "")) &&
    GENERATION.test(String(value.runtimeSession ?? "")) &&
    typeof value.workspaceName === "string" &&
    value.workspaceName.length > 0 &&
    value.workspaceName.length <= 256 &&
    typeof value.semanticPaneId === "string" &&
    value.semanticPaneId.length > 0 &&
    value.semanticPaneId.length <= 256 &&
    typeof value.clientId === "string" &&
    value.clientId.length > 0 &&
    value.clientId.length <= 256 &&
    Number.isSafeInteger(value.rendererEpoch) &&
    Number(value.rendererEpoch) >= 0 &&
    Number.isSafeInteger(value.clientGeneration) &&
    Number(value.clientGeneration) >= 0 &&
    Number.isSafeInteger(value.bindingEpoch) &&
    Number(value.bindingEpoch) >= 1 &&
    /^opentui:[1-9]\d*$/u.test(String(value.processId ?? ""))
  );
}

function parseRequest(value: unknown, key: string): HostFocusControlRequest | null {
  if (
    !exactKeys(value, ["version", "action", "nonce", "expected", "authHmac"]) ||
    value.version !== 1 ||
    !["blur", "focus"].includes(String(value.action)) ||
    typeof value.nonce !== "string" ||
    !/^[0-9a-f]{32}$/u.test(value.nonce) ||
    !exactBinding(value.expected) ||
    !HMAC.test(String(value.authHmac ?? ""))
  )
    return null;
  const request = value as HostFocusControlRequest;
  const unsigned = {
    version: request.version,
    action: request.action,
    nonce: request.nonce,
    expected: request.expected,
  } as const;
  return exactHmac(
    request.authHmac,
    digest(key, "host-focus-control-request", canonicalRequest(unsigned)),
  )
    ? request
    : null;
}

function sameBinding(
  binding: ApplicationHostFocusControlBinding | null,
  expected: HostFocusControlRequest["expected"],
): binding is ApplicationHostFocusControlBinding {
  return (
    binding !== null &&
    Object.entries(expected).every(([field, value]) =>
      Object.is(binding[field as keyof ApplicationHostFocusControlBinding], value),
    )
  );
}

export async function executeApplicationHostFocusTestControl(options: {
  request: unknown;
  key: string;
  currentBinding: () => ApplicationHostFocusControlBinding | null;
  driveFocusState: (focused: boolean) => Readonly<{
    changed: boolean;
    diagnosticEpoch: number | null;
  }>;
}): Promise<Readonly<Record<string, unknown>>> {
  const request = HMAC.test(options.key) ? parseRequest(options.request, options.key) : null;
  if (request === null) return Object.freeze({ version: 1, status: "rejected" });
  const before = options.currentBinding();
  if (!sameBinding(before, request.expected)) return Object.freeze({ version: 1, status: "stale" });
  const driven = options.driveFocusState(request.action === "focus");
  await Promise.resolve();
  const after = options.currentBinding();
  if (!sameBinding(after, request.expected)) return Object.freeze({ version: 1, status: "stale" });
  const expectedFocused = request.action === "focus";
  if (after.rendererFocused !== expectedFocused)
    return Object.freeze({ version: 1, status: "stale" });
  const status = driven.changed ? "changed" : "no-op";
  const bindingHmac = digest(
    options.key,
    "host-focus-control-binding",
    JSON.stringify(request.expected),
  );
  const receipt = {
    version: 1,
    status,
    action: request.action,
    nonceHmac: digest(options.key, "host-focus-control-nonce", request.nonce),
    diagnosticEpoch: driven.diagnosticEpoch,
    state: expectedFocused ? "foreground" : "background",
    bindingHmac,
  } as const;
  return Object.freeze({
    ...receipt,
    receiptHmac: digest(options.key, "host-focus-control-receipt", JSON.stringify(receipt)),
  });
}

export function createApplicationHostFocusTestControl(options: {
  path: string;
  runtimeRoot: string;
  key: string;
  currentBinding: () => ApplicationHostFocusControlBinding | null;
  driveFocusState: (focused: boolean) => Readonly<{
    changed: boolean;
    diagnosticEpoch: number | null;
  }>;
}): Readonly<{ ready: Promise<void>; close: () => Promise<void> }> {
  let root;
  try {
    root = lstatSync(options.runtimeRoot);
  } catch {
    root = null;
  }
  if (
    !options.path.startsWith("/") ||
    options.path.length > 512 ||
    !HMAC.test(options.key) ||
    !root?.isDirectory() ||
    root.isSymbolicLink() ||
    (root.mode & 0o077) !== 0 ||
    resolve(options.runtimeRoot) !== options.runtimeRoot ||
    realpathSync(dirname(options.path)) !== realpathSync(options.runtimeRoot) ||
    dirname(options.path) !== options.runtimeRoot ||
    options.path !== join(options.runtimeRoot, "hf.sock")
  )
    throw new TypeError("invalid host-focus test control configuration");
  try {
    lstatSync(options.path);
    throw new TypeError("host-focus test control target already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    let bytes = Buffer.alloc(0);
    let settled = false;
    const finish = (value: Readonly<Record<string, unknown>>) => {
      if (settled) return;
      settled = true;
      socket.end(`${JSON.stringify(value)}\n`);
    };
    socket.on("data", (chunk) => {
      if (settled) return;
      bytes = Buffer.concat([bytes, Buffer.from(chunk)]);
      if (bytes.length > 8_192) return finish(Object.freeze({ version: 1, status: "rejected" }));
      const newline = bytes.indexOf(0x0a);
      if (newline < 0) return;
      if (newline !== bytes.length - 1)
        return finish(Object.freeze({ version: 1, status: "rejected" }));
      let request: unknown;
      try {
        request = JSON.parse(bytes.subarray(0, newline).toString("utf8"));
      } catch {
        return finish(Object.freeze({ version: 1, status: "rejected" }));
      }
      void executeApplicationHostFocusTestControl({ ...options, request }).then(finish, () =>
        finish(Object.freeze({ version: 1, status: "rejected" })),
      );
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
  });
  let ownedSocket: Stats | null = null;
  const ready = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.path, () => {
      server.off("error", reject);
      chmodSync(options.path, 0o600);
      ownedSocket = lstatSync(options.path);
      resolve();
    });
  });
  let closed = false;
  return Object.freeze({
    ready,
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      let replacementDirectory: string | null = null;
      let replacementPath: string | null = null;
      let movedReplacement: Stats | null = null;
      try {
        const current = lstatSync(options.path);
        if (
          ownedSocket !== null &&
          (current.dev !== ownedSocket.dev || current.ino !== ownedSocket.ino)
        ) {
          replacementDirectory = mkdtempSync(join(options.runtimeRoot, ".hf-close-"));
          replacementPath = join(replacementDirectory, "replacement");
          renameSync(options.path, replacementPath);
          movedReplacement = current;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (movedReplacement !== null && replacementPath !== null && replacementDirectory !== null) {
        const quarantined = lstatSync(replacementPath);
        if (quarantined.dev !== movedReplacement.dev || quarantined.ino !== movedReplacement.ino)
          throw new Error("host-focus replacement changed while closing");
        try {
          lstatSync(options.path);
          throw new Error("host-focus socket path changed while closing");
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
        }
        renameSync(replacementPath, options.path);
        rmdirSync(replacementDirectory);
        return;
      }
      try {
        const current = lstatSync(options.path);
        if (
          ownedSocket?.isSocket() &&
          current.isSocket() &&
          current.dev === ownedSocket.dev &&
          current.ino === ownedSocket.ino
        )
          rmSync(options.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      }
    },
  });
}
