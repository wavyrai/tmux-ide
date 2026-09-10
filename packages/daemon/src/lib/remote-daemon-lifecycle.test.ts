import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { startInstalledRemoteDaemon } from "./remote-daemon-lifecycle.ts";
import type { spawn } from "node:child_process";
function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: vi.fn(),
  });
  const launch = vi.fn(() => child);
  return { child, launch, options: { spawn: launch as unknown as typeof spawn } };
}
it("runs only the fixed installed-daemon command and never captures remote output", async () => {
  const f = fixture();
  const pending = startInstalledRemoteDaemon("mini", f.options);
  f.child.stdout.write("private remote banner");
  f.child.emit("close", 0);
  await pending;
  expect(f.launch.mock.calls[0]).toEqual([
    "ssh",
    [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "--",
      "mini",
      "tmux-ide",
      "update",
      "--daemon",
      "--json",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  ]);
});
it("rejects shell syntax before spawning and cancels only its own child", async () => {
  const f = fixture();
  await expect(startInstalledRemoteDaemon("mini; touch /tmp/no", f.options)).rejects.toThrow();
  expect(f.launch).not.toHaveBeenCalled();
  const controller = new AbortController();
  const pending = startInstalledRemoteDaemon("mini", {
    ...f.options,
    signal: controller.signal,
  }).catch((e) => e);
  controller.abort();
  expect(await pending).toBeInstanceOf(Error);
  expect(f.child.kill).toHaveBeenCalledWith("SIGTERM");
  f.child.emit("close", null);
});
