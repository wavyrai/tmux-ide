/** Fixed image-owned bridge. Nonces remain in the private container volume. */
import console from "node:console";
import process from "node:process";
import { writeFileSync, renameSync, existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { resolveDevelopmentInstance } from "/workspace/tree/packages/daemon/src/lib/development-instance.ts";
import {
  suspendDevelopmentInstance,
  resumeDevelopmentInstance,
} from "/workspace/tree/packages/daemon/src/lib/development-control.ts";
import { readPrivateDevelopmentFile } from "/workspace/tree/packages/daemon/src/lib/development-state.ts";
import { developmentSshAuthority } from "/workspace/tree/packages/daemon/src/lib/development-ssh.ts";
const [action, project, containerId, volumesHash, expected] = process.argv.slice(2);
const file = "/state/container-stop.json";
const hash = (b) => createHash("sha256").update(b).digest("hex");
try {
  if (
    process.getuid() !== 1000 ||
    !/^ti-dev-[a-f0-9]{24}$/.test(project) ||
    !/^[a-f0-9]{64}$/.test(containerId) ||
    !/^[a-f0-9]{64}$/.test(volumesHash)
  )
    throw Error("Invalid binding");
  const binding = { project, containerId, volumesHash };
  const instance = resolveDevelopmentInstance({
    worktree: "/workspace/tree",
    store: "/state/instances",
    name: project,
  });
  if (action === "ready") {
    const { lease } = await developmentSshAuthority(instance);
    console.log(JSON.stringify({ version: 1, state: "ready", lease }));
  } else if (action === "suspend") {
    for (const name of ["admission.json", "serve.json", "control.sock", "sshd.pid"])
      if (existsSync("/state/ssh/" + name)) throw Error("SSH not retired");
    const result = await suspendDevelopmentInstance(instance, binding);
    const bytes = JSON.stringify({ version: 1, binding, result });
    const temp = file + "." + randomUUID();
    writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 });
    renameSync(temp, file);
    console.log(JSON.stringify({ version: 1, state: "suspended", receiptHash: hash(bytes) }));
  } else if (action === "resume") {
    const bytes = readPrivateDevelopmentFile(file)?.bytes;
    if (!bytes || hash(bytes) !== expected) throw Error("Stop proof changed");
    const proof = JSON.parse(bytes.toString("utf8"));
    if (
      proof.version !== 1 ||
      JSON.stringify(proof.binding) !== JSON.stringify(binding) ||
      proof.result?.status !== "suspended"
    )
      throw Error("Stop proof invalid");
    await resumeDevelopmentInstance(instance, binding, proof.result.nonce);
    console.log(JSON.stringify({ version: 1, state: "resumed", receiptHash: hash(bytes) }));
  } else throw Error("Unsupported command");
} catch {
  process.stderr.write("Container lifecycle proof unavailable\n");
  process.exitCode = 1;
}
