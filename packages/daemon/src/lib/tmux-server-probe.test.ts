import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ execute: vi.fn(), capture: vi.fn(), revalidate: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFile: Object.assign(() => {}, {
    [Symbol.for("nodejs.util.promisify.custom")]: mocks.execute,
  }),
}));
vi.mock("./unix-socket-authority.ts", () => ({
  captureUnixSocketIdentity: mocks.capture,
  revalidateUnixSocketIdentity: mocks.revalidate,
}));
import {
  TMUX_SERVER_PROBE_TIMEOUT_MS,
  createDiagnosedTmuxServerProbe,
  createTmuxServerProbe,
} from "./tmux-server-registration.ts";
const socket = Object.freeze({
  path: "/private/test.sock",
  dev: 1,
  ino: 2,
  mtimeNs: 3n,
  birthtimeNs: 4n,
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.capture.mockReturnValue(socket);
  mocks.execute.mockResolvedValue({ stdout: `${socket.path}|41|100\n` });
  mocks.revalidate.mockReturnValue(socket.path);
});
describe("server probe ownership proof", () => {
  it("pins a direct socket before a single read and revalidates before admitting it", async () => {
    const probe = createTmuxServerProbe(process.execPath);
    const observed = await probe({ kind: "path", path: "/test.sock" });
    expect(observed?.nativeServerIdentity).toEqual({ pid: "41", startTime: "100" });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.execute.mock.calls[0]?.[1]).toEqual([
      "-S",
      socket.path,
      "-N",
      "display-message",
      "-p",
      "#{socket_path}|#{pid}|#{start_time}",
    ]);
    expect(mocks.capture.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.execute.mock.invocationCallOrder[0]!,
    );
    expect(mocks.revalidate.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.execute.mock.invocationCallOrder[0]!,
    );
    expect(observed?.valid()).toBe(true);
    mocks.revalidate.mockImplementation(() => {
      throw new Error("replaced");
    });
    expect(observed?.valid()).toBe(false);
  });
  it.each(["path", "inode", "timestamp"])(
    "rejects a socket whose %s changes during the read",
    async (change) => {
      if (change === "timestamp")
        mocks.revalidate.mockImplementation(() => {
          throw new Error("changed");
        });
      else
        mocks.capture.mockReturnValueOnce(socket).mockReturnValue({
          ...socket,
          ...(change === "path" ? { path: "/foreign.sock" } : { ino: 3 }),
        });
      expect(
        await createTmuxServerProbe(process.execPath)({ kind: "path", path: socket.path }),
      ).toBeNull();
    },
  );
  it("keeps two reads for named selectors", async () => {
    expect(
      await createTmuxServerProbe(process.execPath)({ kind: "name", name: "sample" }),
    ).not.toBeNull();
    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(mocks.execute.mock.calls[0]?.[1].slice(0, 2)).toEqual(["-L", "sample"]);
    expect(mocks.execute.mock.calls[1]?.[1].slice(0, 2)).toEqual(["-S", socket.path]);
  });
  it.each([false, true])(
    "retains alias discovery and fences identity drift (%s)",
    async (drift) => {
      mocks.capture
        .mockImplementationOnce(() => {
          throw new Error("alias");
        })
        .mockReturnValue(socket);
      mocks.execute
        .mockResolvedValueOnce({ stdout: `${socket.path}|41|100` })
        .mockResolvedValueOnce({ stdout: `${socket.path}|${drift ? "42|101" : "41|100"}` });
      const observed = await createTmuxServerProbe(process.execPath)({
        kind: "path",
        path: "/alias.sock",
      });
      expect(observed === null).toBe(drift);
      expect(mocks.execute).toHaveBeenCalledTimes(2);
    },
  );
  // #840: the owner registry must be able to tell "tmux was slow" from "tmux says no server".
  it.each([
    [
      "a timeout",
      Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM", code: null }),
      "timeout",
    ],
    [
      "a failed spawn",
      Object.assign(new Error("spawn tmux EAGAIN"), { code: "EAGAIN", errno: -35 }),
      "exec-error",
    ],
    [
      "tmux reporting no server",
      Object.assign(new Error("Command failed"), {
        code: 1,
        stderr: "no server running on /private/test.sock\n",
      }),
      "no-server",
    ],
  ])("says why a probe missed: %s", async (_label, error, failure) => {
    mocks.execute.mockRejectedValue(error);
    const result = await createDiagnosedTmuxServerProbe(process.execPath)({
      kind: "path",
      path: socket.path,
    });
    expect(result).toMatchObject({ failure });
    expect(await createTmuxServerProbe(process.execPath)({ kind: "path", path: socket.path })).toBe(
      null,
    );
    expect(mocks.execute.mock.calls[0]?.[2]).toMatchObject({
      timeout: TMUX_SERVER_PROBE_TIMEOUT_MS,
    });
  });
  it("reports unparsable output and a foreign socket as misses with a reason", async () => {
    const probe = createDiagnosedTmuxServerProbe(process.execPath);
    mocks.execute.mockResolvedValue({ stdout: "" });
    expect(await probe({ kind: "path", path: socket.path })).toMatchObject({
      failure: "unparsable",
    });
    mocks.execute.mockResolvedValue({ stdout: `${socket.path}|41|100\n` });
    mocks.capture.mockReturnValueOnce(socket).mockReturnValue({ ...socket, ino: 3 });
    expect(await probe({ kind: "path", path: socket.path })).toMatchObject({
      failure: "socket-mismatch",
    });
  });
});
