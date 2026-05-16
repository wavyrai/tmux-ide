import { createRequire } from "node:module";
import { z } from "zod";
import {
  ActionContractsZ,
  type ActionInput,
  type ActionName,
  type ActionResult,
} from "../command-center/actions/contract.ts";
import type { ActionErrorCode } from "../command-center/actions/errors.ts";
import {
  clearCanonicalDaemonInfo,
  isCanonicalDaemonAlive,
  readCanonicalDaemonInfo,
  warnOnDaemonVersionSkew,
  type CanonicalDaemonInfo,
} from "./canonical-daemon.ts";
import {
  startEmbeddedDaemon,
  type EmbeddedDaemonHandle,
  type EmbeddedDaemonOptions,
} from "./daemon-embed.ts";

interface ActionFailure {
  code: ActionErrorCode;
  message: string;
  details?: unknown;
}

const FailureEnvelopeZ = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

interface CliActionBridgeDeps {
  fetch: typeof fetch;
  cwd: () => string;
  readCanonicalDaemonInfo: () => CanonicalDaemonInfo | null;
  clearCanonicalDaemonInfo: () => void;
  isCanonicalDaemonAlive: (info: CanonicalDaemonInfo) => Promise<boolean>;
  startEmbeddedDaemon: (opts: EmbeddedDaemonOptions) => Promise<EmbeddedDaemonHandle>;
}

let deps: CliActionBridgeDeps = {
  fetch,
  cwd: () => process.cwd(),
  readCanonicalDaemonInfo,
  clearCanonicalDaemonInfo,
  isCanonicalDaemonAlive,
  startEmbeddedDaemon,
};

export class CliActionInvocationError extends Error {
  readonly code: ActionErrorCode;
  readonly details: unknown;

  constructor(error: ActionFailure) {
    super(error.message);
    this.name = "CliActionInvocationError";
    this.code = error.code;
    this.details = error.details ?? null;
  }
}

export function __setCliActionBridgeDepsForTests(
  overrides: Partial<CliActionBridgeDeps>,
): () => void {
  const previous = deps;
  deps = { ...deps, ...overrides };
  return () => {
    deps = previous;
  };
}

function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref?.();
  return controller.signal;
}

async function isDaemonAlive(port: number): Promise<boolean> {
  try {
    const res = await deps.fetch(`http://127.0.0.1:${port}/health`, {
      signal: timeoutSignal(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function hostnameForClient(bindHostname: string): string {
  return bindHostname === "0.0.0.0" ? "127.0.0.1" : bindHostname;
}

function daemonBaseUrl(info: CanonicalDaemonInfo): string {
  return `http://${hostnameForClient(info.bindHostname)}:${info.port}`;
}

const requireFromHere = createRequire(import.meta.url);

/** The daemon version this CLI client was built against — compared
 *  against the live daemon's advertised version on attach. */
function expectedDaemonVersion(): string {
  try {
    const pkg = requireFromHere("../../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function resolveCanonicalDaemon(): Promise<{
  baseUrl: string;
  transientHandle: EmbeddedDaemonHandle | null;
  restoreCwd: string | null;
} | null> {
  const existing = deps.readCanonicalDaemonInfo();
  if (existing) {
    if (await deps.isCanonicalDaemonAlive(existing)) {
      warnOnDaemonVersionSkew(existing, expectedDaemonVersion());
      return { baseUrl: daemonBaseUrl(existing), transientHandle: null, restoreCwd: null };
    }
    deps.clearCanonicalDaemonInfo();
  }

  // Test / short-lived-CLI escape: skip the transient daemon spawn when
  // TMUX_IDE_CLI_NO_AUTOSTART is set. Callers (e.g. config-cli.test.ts)
  // exercise the local-mutation fallback path; without this guard a
  // single `tmux-ide config enable-team` in a fixture dir would start a
  // full embedded daemon and never tear it down in time.
  if (process.env.TMUX_IDE_CLI_NO_AUTOSTART) {
    return null;
  }

  const dir = deps.cwd();
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    const handle = await deps.startEmbeddedDaemon({
      sessionName: undefined,
      bindHostname: "127.0.0.1",
      silent: true,
    });
    if (!(await isDaemonAlive(handle.port))) {
      await handle.stop();
      process.chdir(previousCwd);
      return null;
    }
    return { baseUrl: handle.apiBaseUrl, transientHandle: handle, restoreCwd: previousCwd };
  } catch {
    process.chdir(previousCwd);
    return null;
  }
}

async function stopTransientDaemon(daemon: {
  transientHandle: EmbeddedDaemonHandle | null;
  restoreCwd: string | null;
}): Promise<void> {
  if (daemon.transientHandle) await daemon.transientHandle.stop().catch(() => undefined);
  if (daemon.restoreCwd) process.chdir(daemon.restoreCwd);
}

export async function tryDispatchAction<Name extends ActionName>(
  name: Name,
  input: ActionInput<Name>,
  options: { cwd?: string } = {},
): Promise<ActionResult<Name> | null> {
  const dir = options.cwd ?? deps.cwd();
  const previousDeps = deps;
  deps = { ...deps, cwd: () => dir };
  const daemon = await resolveCanonicalDaemon();
  deps = previousDeps;
  if (!daemon) return null;

  const contract = ActionContractsZ[name];
  const parsedInput = contract.input.parse(input);
  let response: Response;
  try {
    response = await deps.fetch(`${daemon.baseUrl}/api/v2/action/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsedInput),
      signal: timeoutSignal(2000),
    });
  } catch {
    await stopTransientDaemon(daemon);
    return null;
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    await stopTransientDaemon(daemon);
    return null;
  }
  await stopTransientDaemon(daemon);

  const failure = FailureEnvelopeZ.safeParse(body);
  if (failure.success) {
    throw new CliActionInvocationError({
      code: failure.data.error.code as ActionErrorCode,
      message: failure.data.error.message,
      details: failure.data.error.details,
    });
  }

  const success = z.object({ ok: z.literal(true), result: contract.result }).safeParse(body);
  if (!success.success) return null;
  return success.data.result as ActionResult<Name>;
}
