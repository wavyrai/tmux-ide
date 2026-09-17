import { ActionContractsZ, DaemonIdentitySchema, DaemonHealthSchema } from "@tmux-ide/contracts";
import {
  canonicalDaemonUrl,
  inspectCanonicalDaemonInfo,
  type CanonicalDaemonInfo,
  type CanonicalDaemonInfoState,
} from "./canonical-daemon.ts";
import { IdeError } from "./errors.ts";

export interface RestartCanonicalDaemonDependencies {
  inspect(): CanonicalDaemonInfoState;
  fetch: typeof fetch;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}
const defaults: RestartCanonicalDaemonDependencies = {
  inspect: inspectCanonicalDaemonInfo,
  fetch,
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, ms);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }),
};
const failure = (code: string, message: string) => new IdeError(message, { code });

/** Reset a running owner's generation. Never starts a process or loads installed replacement code. */
export async function restartCanonicalDaemon(
  options: { timeoutMs?: number } = {},
  deps: RestartCanonicalDaemonDependencies = defaults,
): Promise<{
  status: "restarted";
  pid: number;
  previousInstanceId: string;
  instanceId: string;
  productVersion: string;
}> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    throw failure("USAGE", "Invalid daemon restart timeout");
  const controller = new AbortController();
  const timeout = failure(
    "DAEMON_RESTART_TIMEOUT",
    "Daemon restart did not verify a replacement generation before the deadline; no replacement process was launched by this command.",
  );
  const timer = setTimeout(() => controller.abort(timeout), timeoutMs);
  const signal = controller.signal;
  const wait = <T>(operation: Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
      operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  const verified = async (info: CanonicalDaemonInfo): Promise<boolean> => {
    const read = async (path: string) => {
      const response = await wait(
        deps.fetch(canonicalDaemonUrl("http", info.bindHostname, info.port, path), {
          signal,
          redirect: "error",
        }),
      );
      return response.ok ? wait(response.json()) : null;
    };
    const identity = DaemonIdentitySchema.safeParse(await read("/identity"));
    if (
      !identity.success ||
      identity.data.pid !== info.pid ||
      identity.data.instanceId !== info.instanceId ||
      identity.data.startedAt !== info.startedAt ||
      identity.data.protocolVersion !== info.protocolVersion ||
      identity.data.productVersion !== info.productVersion
    )
      return false;
    const health = DaemonHealthSchema.safeParse(await read("/health"));
    return (
      health.success &&
      health.data.protocolVersion === info.protocolVersion &&
      health.data.productVersion === info.productVersion
    );
  };
  try {
    const initial = deps.inspect();
    if (initial.status !== "valid" || !initial.info.authToken)
      throw failure(
        "DAEMON_RESTART_UNAVAILABLE",
        "A valid running canonical daemon with owner credentials is required; this command does not start one.",
      );
    const prior = initial.info;
    if (!(await verified(prior)))
      throw failure(
        "DAEMON_IDENTITY_MISMATCH",
        "Canonical daemon identity or health could not be verified before restart.",
      );
    const latest = deps.inspect();
    if (
      latest.status !== "valid" ||
      latest.info.instanceId !== prior.instanceId ||
      latest.info.pid !== prior.pid ||
      latest.info.authToken !== prior.authToken ||
      latest.info.port !== prior.port ||
      latest.info.bindHostname !== prior.bindHostname ||
      latest.info.startedAt !== prior.startedAt
    )
      throw failure("DAEMON_IDENTITY_MISMATCH", "Canonical daemon changed before restart.");
    const response = await wait(
      deps.fetch(
        canonicalDaemonUrl("http", prior.bindHostname, prior.port, "/api/v2/action/daemon.restart"),
        {
          method: "POST",
          signal,
          redirect: "error",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${prior.authToken}`,
          },
          body: JSON.stringify({ expectedInstanceId: prior.instanceId }),
        },
      ),
    );
    const envelope = (await wait(response.json())) as { ok?: boolean; result?: unknown };
    const accepted = ActionContractsZ["daemon.restart"].result.safeParse(envelope.result);
    if (
      !response.ok ||
      envelope.ok !== true ||
      !accepted.success ||
      accepted.data.instanceId !== prior.instanceId
    )
      throw failure(
        "DAEMON_RESTART_REJECTED",
        `Canonical daemon refused runtime restart (HTTP ${response.status}); its owner must support daemon.restart.`,
      );
    while (!signal.aborted) {
      const state = deps.inspect();
      if (state.status === "valid" && state.info.instanceId !== prior.instanceId) {
        if (
          state.info.pid !== prior.pid ||
          state.info.productVersion !== prior.productVersion ||
          state.info.protocolVersion !== prior.protocolVersion
        )
          throw failure(
            "DAEMON_RESTART_OWNER_CHANGED",
            "A different daemon process or executable version appeared during runtime restart; ownership was not preserved.",
          );
        let healthy = false;
        try {
          healthy = await verified(state.info);
        } catch {
          if (signal.aborted) throw timeout;
        }
        if (healthy) {
          const current = deps.inspect();
          if (
            current.status === "valid" &&
            current.info.instanceId === state.info.instanceId &&
            current.info.pid === state.info.pid &&
            current.info.port === state.info.port &&
            current.info.authToken === state.info.authToken &&
            current.info.bindHostname === state.info.bindHostname &&
            current.info.startedAt === state.info.startedAt &&
            current.info.protocolVersion === state.info.protocolVersion &&
            current.info.productVersion === state.info.productVersion
          )
            return {
              status: "restarted",
              pid: state.info.pid,
              previousInstanceId: prior.instanceId,
              instanceId: state.info.instanceId,
              productVersion: state.info.productVersion,
            };
        }
      }
      await wait(deps.sleep(25, signal));
    }
    throw timeout;
  } catch (error) {
    if (signal.aborted) throw timeout;
    if (error instanceof IdeError) throw error;
    // Never forward fetch/JSON errors which may contain credential-bearing data.
    throw failure(
      "DAEMON_RESTART_FAILED",
      "Could not complete or verify daemon runtime restart; inspect daemon status before retrying.",
    );
  } finally {
    clearTimeout(timer);
  }
}
