// Private loopback sshd transport for the owned GUI fixture, never personal SSH config.
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
export async function createNativeGuiSsh({ repo, fleet, daemon, env }) {
  const { createOwnedSshFixture, createMacProcessIdentity, ownedProcesses } = await import(
    pathToFileURL(join(repo, "scripts/lib/owned-ssh-fixture.mjs")).href
  );
  const parent = await mkdtemp(join(await realpath(tmpdir()), "gpui-ssh-"));
  const allocations = [];
  let kernel, timer, captureFailure, capture;
  const tracker = ownedProcesses({
    identify: (pid) => kernel.identify(pid),
    list: async () =>
      execFileSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
        .trim()
        .split("\n")
        .map((line) => {
          const [pid, ppid] = line.trim().split(/\s+/).map(Number);
          return { pid, ppid };
        }),
  });
  const dispose = async () => {
    clearInterval(timer);
    await capture;
    console.error(
      JSON.stringify({ sshCleanup: allocations.map((a) => a.diagnostics?.()).filter(Boolean) }),
    );
    // Do not remove ownership witnesses if process retirement cannot be confirmed.
    await tracker.dispose();
    for (const allocation of [...allocations].reverse()) await allocation.disposeFiles();
    await rm(parent, { recursive: true, force: true });
    if (captureFailure) throw Error("Owned SSH identity capture failed");
  };
  try {
    kernel = await createMacProcessIdentity({ parent, onAllocated: (a) => allocations.push(a) });
    const ssh = await createOwnedSshFixture({
      parent,
      node: process.execPath,
      targetPort: daemon.record.port,
      processes: tracker,
      handshake: async () => ({ version: 1, daemon: daemon.record }),
      onAllocated: (a) => allocations.push(a),
    });
    const client = join(fleet.root, "ssh-client"),
      bin = join(client, "bin");
    await mkdir(bin, { recursive: true, mode: 0o700 });
    // Config path is validated by owned fixture under the private per-user temp root.
    await writeFile(join(bin, "ssh"), `#!/bin/sh\nexec /usr/bin/ssh -F '${ssh.config}' "$@"\n`, {
      mode: 0o700,
    });
    timer = setInterval(() => {
      if (capture) return;
      capture = tracker
        .capture()
        .catch(() => {
          captureFailure = true;
        })
        .finally(() => {
          capture = undefined;
        });
    }, 100);
    return {
      environment: {
        ...env,
        PATH: `${bin}:${env.PATH}`,
        TMUX_IDE_HOME: client,
        TMUX_IDE_REGISTRY_DIR: client,
        TMUX_IDE_DAEMON_INFO_DIR: client,
      },
      host: { sshTarget: "target" },
      check() {
        if (captureFailure) {
          console.error(
            JSON.stringify({ sshCheck: allocations.map((a) => a.diagnostics?.()).filter(Boolean) }),
          );
          throw Error("Owned SSH identity capture failed");
        }
      },
      diagnostics: () => allocations.map((a) => a.diagnostics?.()).filter(Boolean),
      dispose,
    };
  } catch (error) {
    console.error(JSON.stringify({ sshSetup: allocations.map((a) => a.diagnostics?.()) }));
    try {
      await dispose();
    } catch {
      throw Error("Owned SSH setup/cleanup failed; ownership files retained");
    }
    throw error;
  }
}
