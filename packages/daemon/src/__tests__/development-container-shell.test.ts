import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
const mocks = vi.hoisted(() => ({ ready: vi.fn(), spawn: vi.fn() }));
vi.mock("../lib/development-container.ts", () => ({ withReadyDevelopmentContainer: mocks.ready }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
import {
  launchDevelopmentContainerShell,
  developmentContainerShellCommand,
} from "../lib/development-container-shell.ts";
import type { DevelopmentComposeProject } from "../lib/development-compose.ts";
const project = { name: "ti-dev-0123456789abcdef01234567" } as DevelopmentComposeProject;
const containerId = "a".repeat(64);
const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
afterEach(() => {
  for (const [stream, descriptor] of [
    [process.stdin, stdinTTY],
    [process.stdout, stdoutTTY],
  ] as const) {
    if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
    else delete stream.isTTY;
  }
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.useRealTimers();
});
function fixture() {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  const banner = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  let locked = false;
  mocks.ready.mockImplementation(async (_project, action, signal) => {
    signal?.throwIfAborted();
    locked = true;
    try {
      return await action({ containerId });
    } finally {
      locked = false;
    }
  });
  const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
  mocks.spawn.mockImplementation(() => {
    expect(locked).toBe(true);
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  return { child, banner, locked: () => locked };
}
it("admits exact UID/worktree/container argv under lock, then releases before interactive completion", async () => {
  const f = fixture();
  const admitted = await launchDevelopmentContainerShell(project);
  expect(f.locked()).toBe(false);
  expect(mocks.spawn).toHaveBeenCalledWith(
    "docker",
    [
      "exec",
      "--interactive",
      "--tty",
      "--user",
      "1000",
      "--workdir",
      "/workspace/tree",
      containerId,
      "/bin/bash",
      "--noprofile",
      "--norc",
    ],
    { stdio: "inherit" },
  );
  expect(f.banner.mock.calls[0]![0]).toContain(developmentContainerShellCommand(project));
  expect(f.banner.mock.calls[0]![0]).toContain("no host source sync");
  expect(developmentContainerShellCommand(project)).toContain("'--name' '" + project.name + "'");
  f.child.emit("close", 7, null);
  await expect(admitted.completion).resolves.toBe(7);
});
it("refuses non-TTY before any admission or Docker call", async () => {
  fixture();
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
  await expect(launchDevelopmentContainerShell(project)).rejects.toThrow("interactive terminal");
  expect(mocks.ready).not.toHaveBeenCalled();
  expect(mocks.spawn).not.toHaveBeenCalled();
});
it("propagates ready refusal without starting or resuming anything", async () => {
  fixture();
  mocks.ready.mockRejectedValue(new Error("suspended"));
  await expect(launchDevelopmentContainerShell(project)).rejects.toThrow("suspended");
  expect(mocks.spawn).not.toHaveBeenCalled();
});
it("sanitizes spawn errors and awaits retained child close before rejecting", async () => {
  const f = fixture();
  mocks.spawn.mockImplementation(() => {
    queueMicrotask(() => {
      f.child.emit("error", Error("private-token"));
      f.child.emit("close", -2, null);
    });
    return f.child;
  });
  await expect(launchDevelopmentContainerShell(project)).rejects.toThrow(
    "Docker client unavailable",
  );
  expect(f.locked()).toBe(false);
});
it("cancellation escalates only the retained Docker client and reaps it", async () => {
  const f = fixture(),
    abort = new AbortController();
  const admitted = await launchDevelopmentContainerShell(project, { signal: abort.signal });
  vi.useFakeTimers();
  abort.abort();
  expect(f.child.kill).toHaveBeenCalledWith("SIGTERM");
  await vi.advanceTimersByTimeAsync(250);
  expect(f.child.kill).toHaveBeenCalledWith("SIGKILL");
  f.child.emit("close", null, "SIGTERM");
  await expect(admitted.completion).resolves.toBe(143);
  expect(vi.getTimerCount()).toBe(0);
});
it("admission failure after spawn cleans up before escaping and never holds interactive lock", async () => {
  const f = fixture();
  mocks.ready.mockImplementation(async (_project, action) => {
    await action({ containerId });
    throw Error("lock release refused");
  });
  mocks.spawn.mockImplementation(() => {
    queueMicrotask(() => f.child.emit("spawn"));
    return f.child;
  });
  f.child.kill.mockImplementation(() => {
    queueMicrotask(() => f.child.emit("close", null, "SIGTERM"));
    return true;
  });
  await expect(launchDevelopmentContainerShell(project)).rejects.toThrow("lock release refused");
  expect(f.child.kill).toHaveBeenCalledWith("SIGTERM");
});
it("pre-aborted admission never spawns", async () => {
  fixture();
  await expect(
    launchDevelopmentContainerShell(project, { signal: AbortSignal.abort() }),
  ).rejects.toBeDefined();
  expect(mocks.spawn).not.toHaveBeenCalled();
});
