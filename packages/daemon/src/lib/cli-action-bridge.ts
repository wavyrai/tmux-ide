import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  ActionContractsZ,
  type ActionInput,
  type ActionName,
  type ActionResult,
} from "../command-center/actions/contract.ts";
import type { ActionErrorCode } from "../command-center/actions/errors.ts";
import {
  canonicalDaemonUrl,
  isCanonicalDaemonAlive,
  readCanonicalDaemonInfo,
  warnOnDaemonVersionSkew,
  type CanonicalDaemonInfo,
} from "./canonical-daemon.ts";
import {
  ensureCanonicalDaemon,
  type CanonicalDaemonBootstrapOptions,
} from "./canonical-daemon-bootstrap.ts";
import { PANE_SOURCE_CREDENTIAL_HEADER } from "./pane-source-credentials.ts";

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

/** Owner-only semantic mutations that are safe to retry with one stable operation id. */
const RETRY_SAFE_OWNER_ACTIONS: ReadonlySet<ActionName> = new Set([
  "workspace.pane.create",
  "workspace.open",
  "workspace.window.split",
  "workspace.window.kill",
  "workspace.pane.kill",
  "workspace.session.kill",
  "workspace.rename",
  "workspace.pane.zoom.toggle",
  "workspace.pane.select",
  "workspace.pane.send",
  "workspace.pane.swap",
  "workspace.pane.resize",
]);

// Local actions can briefly queue behind tmux and daemon lifecycle work during
// startup or a busy workspace. Keep the request budget comfortably above that
// queue without changing the fast path; the stable operation id still makes a
// lost response safe to retry exactly once.
const ACTION_OPERATION_TIMEOUT_MS = 10_000;

interface CliActionBridgeDeps {
  fetch: typeof fetch;
  cwd: () => string;
  readCanonicalDaemonInfo: () => CanonicalDaemonInfo | null;
  isCanonicalDaemonAlive: (info: CanonicalDaemonInfo) => Promise<boolean>;
  ensureCanonicalDaemon: (
    options: CanonicalDaemonBootstrapOptions,
  ) => Promise<{ candidate: CanonicalDaemonInfo }>;
  cliEntryPath: () => string;
}

function defaultCliEntryPath(): string {
  if (process.env.TMUX_IDE_CLI) return resolve(process.env.TMUX_IDE_CLI);
  const current = fileURLToPath(import.meta.url);
  // esbuild collapses import.meta.url to bin/cli.js for this bundled module.
  if (basename(current) === "cli.js" && basename(dirname(current)) === "bin") return current;
  // Source and tsc output both live at packages/daemon/{src,dist}/lib.
  return resolve(dirname(current), "../../../../bin/cli.js");
}

let deps: CliActionBridgeDeps = {
  fetch,
  cwd: () => process.cwd(),
  readCanonicalDaemonInfo,
  isCanonicalDaemonAlive,
  ensureCanonicalDaemon,
  cliEntryPath: defaultCliEntryPath,
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

function daemonBaseUrl(info: CanonicalDaemonInfo): string {
  return canonicalDaemonUrl("http", info.bindHostname, info.port);
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

async function resolveCanonicalDaemon(
  bridgeDeps: CliActionBridgeDeps,
  options: { autostart: boolean; cwd: string },
): Promise<{
  baseUrl: string;
  ownerToken: string | null;
} | null> {
  const existing = bridgeDeps.readCanonicalDaemonInfo();
  if (existing) {
    if (await bridgeDeps.isCanonicalDaemonAlive(existing)) {
      warnOnDaemonVersionSkew(existing, expectedDaemonVersion());
      return {
        baseUrl: daemonBaseUrl(existing),
        ownerToken: existing.authToken,
      };
    }
    // Stale canonical state is removed only after the persistent owner wins
    // the daemon's atomic process-lifetime claim.
  }

  // Test / short-lived-CLI escape: skip persistent daemon bootstrap when
  // TMUX_IDE_CLI_NO_AUTOSTART is set. Callers (e.g. config-cli.test.ts)
  // exercise the local-mutation fallback path; without this guard a
  // single `tmux-ide config enable-team` in a fixture dir would start a
  // full embedded daemon and never tear it down in time.
  if (!options.autostart || process.env.TMUX_IDE_CLI_NO_AUTOSTART) {
    return null;
  }

  try {
    const { candidate } = await bridgeDeps.ensureCanonicalDaemon({
      entryPath: bridgeDeps.cliEntryPath(),
      cwd: options.cwd,
    });
    warnOnDaemonVersionSkew(candidate, expectedDaemonVersion());
    return {
      baseUrl: daemonBaseUrl(candidate),
      ownerToken: candidate.authToken,
    };
  } catch {
    return null;
  }
}

export async function tryDispatchAction<Name extends ActionName>(
  name: Name,
  input: ActionInput<Name>,
  options: {
    cwd?: string;
    operationId?: string;
    autostart?: boolean;
    sourcePaneCredential?: string;
  } = {},
): Promise<ActionResult<Name> | null> {
  const bridgeDeps = deps;
  const dir = options.cwd ?? bridgeDeps.cwd();
  const daemon = await resolveCanonicalDaemon(bridgeDeps, {
    autostart: options.autostart ?? true,
    cwd: dir,
  });
  if (!daemon) return null;

  const contract = ActionContractsZ[name];
  const parsedInput = contract.input.parse(input);
  const operationId = RETRY_SAFE_OWNER_ACTIONS.has(name)
    ? (options.operationId ?? randomUUID())
    : null;
  if (operationId && !daemon.ownerToken) {
    return null;
  }
  // One deadline covers both attempts. A retry never receives a fresh time
  // budget and always retains the exact same operation id.
  const operationSignal = timeoutSignal(ACTION_OPERATION_TIMEOUT_MS);
  const request = (): Promise<Response> =>
    bridgeDeps.fetch(`${daemon.baseUrl}/api/v2/action/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(daemon.ownerToken ? { Authorization: `Bearer ${daemon.ownerToken}` } : {}),
        ...(operationId ? { "X-Tmux-Ide-Operation-Id": operationId } : {}),
        ...(options.sourcePaneCredential
          ? { [PANE_SOURCE_CREDENTIAL_HEADER]: options.sourcePaneCredential }
          : {}),
      },
      body: JSON.stringify(parsedInput),
      signal: operationSignal,
    });
  const maximumAttempts = operationId ? 2 : 1;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    let body: unknown;
    try {
      const response = await request();
      body = await response.json();
    } catch {
      // A timeout or truncated body may occur after the daemon committed.
      // The next attempt retains the exact same host operation id.
      if (operationSignal.aborted) break;
      continue;
    }

    const failure = FailureEnvelopeZ.safeParse(body);
    if (failure.success) {
      throw new CliActionInvocationError({
        code: failure.data.error.code as ActionErrorCode,
        message: failure.data.error.message,
        details: failure.data.error.details,
      });
    }

    const success = z.object({ ok: z.literal(true), result: contract.result }).safeParse(body);
    if (success.success) return success.data.result as ActionResult<Name>;
    // A JSON body that does not satisfy either strict envelope may be a
    // truncated proxy response. Retry only the idempotent semantic mutation.
  }
  return null;
}
