import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createConnection } from "node:net";
import { z } from "zod";
import { tmuxClientEnvironment } from "./tmux-client-execution.ts";
import {
  captureUnixSocketIdentity,
  revalidateUnixSocketIdentity,
} from "./unix-socket-authority.ts";
import {
  MAX_TMUX_SERVER_OWNERS,
  TmuxServerRegistrationSchemaZ,
  isTmuxServerObservation,
  type TmuxServerObservation,
  type TmuxServerProbeFailure,
  type TmuxServerProbeResult,
  type TmuxServerRegistration,
} from "./tmux-server-owners.ts";

const exec = promisify(execFile);
const FileSchema = z
  .object({
    version: z.literal(1),
    servers: z.array(TmuxServerRegistrationSchemaZ).max(MAX_TMUX_SERVER_OWNERS),
  })
  .strict()
  .superRefine((file, ctx) => {
    if (new Set(file.servers.map((server) => server.serverId)).size !== file.servers.length)
      ctx.addIssue({ code: "custom", message: "Duplicate server registration" });
  });
export function readTmuxServerRegistrations(path: string): readonly TmuxServerRegistration[] {
  try {
    return FileSchema.parse(JSON.parse(readFileSync(path, "utf8"))).servers;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
export function writeTmuxServerRegistrations(
  path: string,
  registrations: readonly TmuxServerRegistration[],
): void {
  const file = FileSchema.parse({ version: 1, servers: registrations });
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* rename already removed it */
    }
  }
}
export const TMUX_SERVER_PROBE_TIMEOUT_MS = 500;

/**
 * Where the daemon's tmux clients find this selector's socket. They run with
 * a scrubbed environment (no TMUX_TMPDIR), so a named socket is always in
 * /tmp/tmux-<uid>/.
 */
export function tmuxSelectorSocketPath(selector: TmuxServerRegistration["selector"]): string {
  return selector.kind === "path"
    ? selector.path
    : join("/tmp", `tmux-${String(process.getuid?.() ?? 0)}`, selector.name);
}
/** One stat: is there a socket file a server could be listening on? */
export function tmuxServerSocketPresent(selector: TmuxServerRegistration["selector"]): boolean {
  try {
    return statSync(tmuxSelectorSocketPath(selector)).isSocket();
  } catch (error) {
    // Only "it is not there" means absent; anything else is left to the probe.
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}
export const SOCKET_CONNECT_TIMEOUT_MS = 250;
/**
 * Does this unix socket refuse connections outright (nobody listening, or no
 * socket at all)? A connection that is accepted is closed at once; a timeout
 * or any other error is not a refusal.
 */
export function unixSocketRefusesConnections(
  path: string,
  timeoutMs: number = SOCKET_CONNECT_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ path });
    const settle = (refused: boolean): void => {
      socket.removeAllListeners();
      socket.on("error", () => undefined);
      socket.destroy();
      resolve(refused);
    };
    socket.setTimeout(timeoutMs, () => settle(false));
    socket.once("connect", () => settle(false));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      settle(error.code === "ECONNREFUSED" || error.code === "ENOENT" || error.code === "ENOTSOCK"),
    );
  });
}
/**
 * Say why a probe produced nothing. Only tmux itself answering "no server"
 * (a clean non-zero exit) is a statement about the server; a timeout or a
 * failed spawn says nothing about it (#840).
 */
export function classifyTmuxServerProbeError(
  error: unknown,
  durationMs: number,
): TmuxServerProbeFailure {
  const failed = error as NodeJS.ErrnoException & {
    killed?: boolean;
    signal?: string | null;
    stderr?: string;
  };
  const detail = (
    (typeof failed?.stderr === "string" && failed.stderr.trim()) ||
    (error instanceof Error ? error.message : String(error))
  ).slice(0, 200);
  const failure: TmuxServerProbeFailure["failure"] =
    failed?.killed === true || (typeof failed?.signal === "string" && failed.signal.length > 0)
      ? "timeout"
      : typeof failed?.code === "number"
        ? "no-server"
        : "exec-error";
  return { failure, detail, durationMs: Math.round(durationMs) };
}
/** Discovery never creates a server, loads configuration, or attaches a client. */
export function createTmuxServerProbe(
  executable: string,
): (selector: TmuxServerRegistration["selector"]) => Promise<TmuxServerObservation | null> {
  const probe = createDiagnosedTmuxServerProbe(executable);
  return async (selector) => {
    const result = await probe(selector);
    return isTmuxServerObservation(result) ? result : null;
  };
}
/** The same probe, but a miss says why (timeout, failed spawn, no server, …). */
export function createDiagnosedTmuxServerProbe(
  executable: string,
): (selector: TmuxServerRegistration["selector"]) => Promise<TmuxServerProbeResult> {
  const executablePath = realpathSync(executable);
  const env = tmuxClientEnvironment(process.env, executablePath);
  return async (selector) => {
    const started = performance.now();
    const failed = (failure: TmuxServerProbeFailure["failure"], detail: string) => ({
      failure,
      detail,
      durationMs: Math.round(performance.now() - started),
    });
    const args = selector.kind === "path" ? ["-S", selector.path] : ["-L", selector.name];
    const read = async (selection: readonly string[]) =>
      (
        await exec(
          executablePath,
          [...selection, "-N", "display-message", "-p", "#{socket_path}|#{pid}|#{start_time}"],
          { env, encoding: "utf8", timeout: TMUX_SERVER_PROBE_TIMEOUT_MS, maxBuffer: 8192 },
        )
      ).stdout.trimEnd();
    try {
      // A direct socket can be pinned before contacting tmux. Named servers
      // and aliases still need discovery followed by an explicit-path proof.
      let pinned: ReturnType<typeof captureUnixSocketIdentity> | null = null;
      if (selector.kind === "path") {
        try {
          pinned = captureUnixSocketIdentity(selector.path);
        } catch {
          // Preserve discovery for aliases which are not direct socket paths.
        }
      }
      const first = await read(pinned ? ["-S", pinned.path] : args);
      const match = /^(.*)\|([1-9][0-9]*)\|([1-9][0-9]*)$/u.exec(first);
      if (!match) return failed("unparsable", `${first.length} bytes of probe output`);
      const reportedSocket = captureUnixSocketIdentity(match[1]!);
      const socket = pinned ?? reportedSocket;
      if (pinned) {
        if (
          reportedSocket.path !== pinned.path ||
          reportedSocket.dev !== pinned.dev ||
          reportedSocket.ino !== pinned.ino
        )
          return failed("socket-mismatch", "the server answered from another socket");
      } else if ((await read(["-S", socket.path])) !== first)
        return failed("socket-mismatch", "the explicit-path proof differed");
      revalidateUnixSocketIdentity(socket);
      return {
        nativeServerIdentity: { pid: match[2]!, startTime: match[3]! },
        fingerprint: createHash("sha256")
          .update(JSON.stringify([socket.path, match[2], match[3]]))
          .digest("hex"),
        authority: { executablePath, socketSelector: { kind: "path", path: socket.path } },
        valid: () => {
          try {
            revalidateUnixSocketIdentity(socket);
            return true;
          } catch {
            return false;
          }
        },
      };
    } catch (error) {
      return classifyTmuxServerProbeError(error, performance.now() - started);
    }
  };
}
