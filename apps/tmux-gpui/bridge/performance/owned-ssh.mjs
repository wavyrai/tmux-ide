import { setTimeout } from "node:timers";
const { AbortSignal, fetch } = globalThis;
import { spawn, execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
export const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'";
async function port() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
export async function ownedSsh({ root, environment, node, cli, daemonPort, track }) {
  const dir = join(root, "ssh");
  await mkdir(dir, { mode: 0o700 });
  for (const key of ["host", "client"])
    execFileSync("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(dir, key)]);
  const discover = join(dir, "discover");
  const exports = Object.entries(environment)
    .map(([k, v]) => `${k}=${quote(v)}`)
    .join(" ");
  await writeFile(
    discover,
    `#!/bin/sh\nexec /usr/bin/env -i ${exports} ${quote(node)} ${quote(cli)} remote-daemon-info --json\n`,
    { mode: 0o700 },
  );
  await writeFile(
    join(dir, "authorized_keys"),
    `command="${discover}",no-agent-forwarding,no-X11-forwarding,no-pty ${await readFile(join(dir, "client.pub"), "utf8")}`,
    { mode: 0o600 },
  );
  const remotePort = await port(),
    forwardPort = await port();
  const config = join(dir, "sshd_config");
  await writeFile(
    config,
    [
      `Port ${remotePort}`,
      "ListenAddress 127.0.0.1",
      `HostKey ${join(dir, "host")}`,
      `AuthorizedKeysFile ${join(dir, "authorized_keys")}`,
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "UsePAM no",
      "StrictModes no",
      `PidFile ${join(dir, "pid")}`,
      "AllowTcpForwarding yes",
      "Compression no",
    ].join("\n") + "\n",
    { mode: 0o600 },
  );
  const server = track(spawn("/usr/sbin/sshd", ["-D", "-e", "-f", config], { stdio: "ignore" }));
  await new Promise((r) => setTimeout(r, 300));
  if (server.exitCode !== null) throw Error("owned sshd failed");
  const clientConfig = join(dir, "config"),
    alias = "gui-measurement-owned";
  await writeFile(
    clientConfig,
    [
      `Host ${alias}`,
      " HostName 127.0.0.1",
      ` Port ${remotePort}`,
      ` IdentityFile ${join(dir, "client")}`,
      " IdentitiesOnly yes",
      " BatchMode yes",
      " StrictHostKeyChecking no",
      " UserKnownHostsFile /dev/null",
      " ControlMaster no",
      " ControlPath none",
      " Compression no",
    ].join("\n") + "\n",
    { mode: 0o600 },
  );
  const bin = join(dir, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "ssh"),
    `#!/bin/sh\nexec /usr/bin/ssh -F ${quote(clientConfig)} "$@"\n`,
    { mode: 0o700 },
  );
  const tunnel = track(
    spawn(
      "/usr/bin/ssh",
      [
        "-F",
        clientConfig,
        "-N",
        "-o",
        "ExitOnForwardFailure=yes",
        "-L",
        `${forwardPort}:127.0.0.1:${daemonPort}`,
        alias,
      ],
      { stdio: "ignore" },
    ),
  );
  const url = `http://127.0.0.1:${forwardPort}/`;
  for (let n = 0; n < 50; n++) {
    try {
      await fetch(url + "api/sessions", { signal: AbortSignal.timeout(500) });
      return { url, alias, path: bin, serverPid: server.pid, tunnelPid: tunnel.pid };
    } catch {
      // The tunnel may not be ready yet; retry until the bounded deadline.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("owned SSH forwarding deadline");
}
