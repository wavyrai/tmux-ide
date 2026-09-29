import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { ownedProcesses } from "./source/scripts/lib/owned-ssh-fixture.mjs";
const execute = promisify(execFile);
export function createOwnedHarness(options, identify, io = {}) {
  const list =
    io.list ??
    (async () => {
      const { stdout } = await execute("/bin/ps", ["-axo", "pid=,ppid="], {
        timeout: 3000,
        maxBuffer: 1048576,
      });
      return stdout
        .trim()
        .split("\n")
        .map((line) => {
          const [pid, ppid] = line.trim().split(/\s+/u).map(Number);
          return { pid, ppid };
        });
    });
  const tracker = ownedProcesses({ identify, list, signal: io.signal });
  const child = tracker.retain(
    (io.spawn ?? spawn)(options.command, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  let bytes = Buffer.alloc(0);
  const capture = (chunk) => {
    bytes = Buffer.concat([bytes, Buffer.from(chunk)]).subarray(-65536);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  let stopping;
  return {
    child,
    output: () => bytes.toString("utf8"),
    capture: () => tracker.capture(),
    stop: () =>
      (stopping ??= (async () => {
        await tracker.dispose();
        if (child.pid && (await identify(child.pid)) !== null)
          throw Error("Owned daemon exit unproven");
      })()),
  };
}
