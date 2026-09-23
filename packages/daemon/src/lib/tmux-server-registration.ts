import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { tmuxClientEnvironment } from "./tmux-client-execution.ts";
import {
  captureUnixSocketIdentity,
  revalidateUnixSocketIdentity,
} from "./unix-socket-authority.ts";
import {
  MAX_TMUX_SERVER_OWNERS,
  TmuxServerRegistrationSchemaZ,
  type TmuxServerObservation,
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
/** Discovery never creates a server, loads configuration, or attaches a client. */
export function createTmuxServerProbe(
  executable: string,
): (selector: TmuxServerRegistration["selector"]) => Promise<TmuxServerObservation | null> {
  const executablePath = realpathSync(executable);
  const env = tmuxClientEnvironment(process.env);
  return async (selector) => {
    const args = selector.kind === "path" ? ["-S", selector.path] : ["-L", selector.name];
    const read = async (selection: readonly string[]) =>
      (
        await exec(
          executablePath,
          [...selection, "-N", "display-message", "-p", "#{socket_path}|#{pid}|#{start_time}"],
          { env, encoding: "utf8", timeout: 500, maxBuffer: 8192 },
        )
      ).stdout.trimEnd();
    try {
      const first = await read(args);
      const match = /^(.*)\|([1-9][0-9]*)\|([1-9][0-9]*)$/u.exec(first);
      if (!match) return null;
      const socket = captureUnixSocketIdentity(match[1]!);
      if ((await read(["-S", socket.path])) !== first) return null;
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
    } catch {
      return null;
    }
  };
}
