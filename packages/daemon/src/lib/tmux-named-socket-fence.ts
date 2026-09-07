import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import {
  captureUnixSocketIdentity,
  revalidateUnixSocketIdentity,
  type UnixSocketIdentity,
} from "./unix-socket-authority.ts";
import type { WorkspacePaneTmuxAuthority } from "./workspace-pane-creation.ts";

const execAsync = promisify(execFile);
// One authority object belongs to one daemon generation. A runner created
// later in that generation must inherit its first server, not repin a new one.
const states = new WeakMap<WorkspacePaneTmuxAuthority, { identity: UnixSocketIdentity | null }>();

export function createNamedSocketFence(
  authority: WorkspacePaneTmuxAuthority,
  executable: string,
  environment: NodeJS.ProcessEnv,
) {
  if (authority.socketSelector.kind !== "name")
    throw new TypeError("Expected named tmux authority");
  const nameArgs = ["-L", authority.socketSelector.name];
  const query = [...nameArgs, "-N", "display-message", "-p", "#{socket_path}"];
  let state = states.get(authority);
  if (!state) {
    state = { identity: null };
    states.set(authority, state);
  }
  const shared = state;
  const argv = () =>
    shared.identity ? ["-S", revalidateUnixSocketIdentity(shared.identity)] : nameArgs;
  const accept = (path: string) => {
    if (!shared.identity) shared.identity = captureUnixSocketIdentity(path.trimEnd());
    return argv();
  };
  const options = { encoding: "utf8" as const, env: environment, timeout: 1_000, maxBuffer: 8_192 };
  return {
    observe(identity: UnixSocketIdentity): void {
      revalidateUnixSocketIdentity(identity);
      if (!shared.identity) shared.identity = identity;
      revalidateUnixSocketIdentity(shared.identity);
    },
    resolve(): string[] {
      if (shared.identity) return argv();
      let path: string;
      try {
        path = execFileSync(executable, query, { ...options, stdio: ["ignore", "pipe", "pipe"] });
      } catch {
        return argv();
      }
      return accept(path);
    },
    async resolveAsync(signal?: AbortSignal): Promise<string[]> {
      if (shared.identity) return argv();
      let path: string;
      try {
        path = (await execAsync(executable, query, { ...options, signal })).stdout;
      } catch {
        if (signal?.aborted) signal.throwIfAborted();
        return argv();
      }
      return accept(path);
    },
    isPinned: () => shared.identity !== null,
  };
}
