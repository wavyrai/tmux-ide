import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { resolveOrdinaryTmuxClient } from "../tmux-client-execution.ts";

it("resolves relative and empty PATH entries against the supplied child cwd", () => {
  const directory = mkdtempSync(join(tmpdir(), "ordinary-tmux-cwd-"));
  try {
    mkdirSync(join(directory, "bin"));
    for (const relative of ["tmux", "bin/tmux"]) {
      writeFileSync(join(directory, relative), "#!/bin/sh\nexit 0\n");
      chmodSync(join(directory, relative), 0o755);
    }
    const environment = {
      PATH: "bin",
      TMUX: "/private/socket,1,0",
      TERMINFO_DIRS: "/user/catalog",
    };
    const selected = resolveOrdinaryTmuxClient(environment, directory);
    expect(selected.executable).toBe(realpathSync(join(directory, "bin/tmux")));
    expect(selected.environment).toBe(environment);
    expect(
      resolveOrdinaryTmuxClient({ PATH: "", TMUX: environment.TMUX }, directory).executable,
    ).toBe(realpathSync(join(directory, "tmux")));
    // Missing PATH uses the OS default search, not the explicit-empty cwd rule.
    try {
      expect(resolveOrdinaryTmuxClient({ TMUX: environment.TMUX }, directory).executable).not.toBe(
        realpathSync(join(directory, "tmux")),
      );
    } catch (error) {
      expect((error as Error).message).toBe("tmux_executable_unavailable");
    }
    expect(() =>
      resolveOrdinaryTmuxClient({ ...environment, TMUX_IDE_TMUX_BIN: "bin/tmux" }, directory),
    ).toThrow("tmux_executable_unavailable");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("starts a new server with bundled tmux, but keeps the PATH client for a running one", () => {
  const directory = mkdtempSync(join(tmpdir(), "ordinary-tmux-start-"));
  try {
    mkdirSync(join(directory, "bin"));
    mkdirSync(join(directory, "bundle"));
    for (const relative of ["bin/tmux", "bundle/tmux"]) {
      writeFileSync(join(directory, relative), "#!/bin/sh\nexit 0\n");
      chmodSync(join(directory, relative), 0o755);
    }
    const bundled = () => realpathSync(join(directory, "bundle/tmux"));
    const pathTmux = realpathSync(join(directory, "bin/tmux"));
    const environment = { PATH: join(directory, "bin"), TMUX_TMPDIR: directory };
    const asked: string[] = [];
    const serverRunning = (socket: string) => {
      asked.push(socket);
      return false;
    };
    expect(
      resolveOrdinaryTmuxClient(environment, directory, { bundled, serverRunning }).executable,
    ).toBe(bundled());
    const uid = process.getuid!();
    expect(asked).toEqual([join(directory, `tmux-${uid}`, "default")]);
    // Ordinary clients pass no -S or -L, so the socket env vars do not move the target.
    resolveOrdinaryTmuxClient({ ...environment, TMUX_IDE_TMUX_SOCKET_NAME: "work" }, directory, {
      bundled,
      serverRunning,
    });
    expect(asked.at(-1)).toBe(join(directory, `tmux-${uid}`, "default"));
    // A running server keeps the PATH client, as before.
    expect(
      resolveOrdinaryTmuxClient(environment, directory, { bundled, serverRunning: () => true })
        .executable,
    ).toBe(pathTmux);
    // Inside tmux the server exists; TMUX_IDE_TMUX_BIN always wins.
    expect(
      resolveOrdinaryTmuxClient({ ...environment, TMUX: "/x/s,1,0" }, directory, {
        bundled,
        serverRunning,
      }).executable,
    ).toBe(pathTmux);
    expect(
      resolveOrdinaryTmuxClient({ ...environment, TMUX_IDE_TMUX_BIN: pathTmux }, directory, {
        bundled,
        serverRunning,
      }).executable,
    ).toBe(pathTmux);
    // No bundle: PATH as before.
    expect(
      resolveOrdinaryTmuxClient(environment, directory, { bundled: () => null, serverRunning })
        .executable,
    ).toBe(pathTmux);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("finds tmux on an absolute PATH entry when the current directory was deleted (#585)", () => {
  const directory = mkdtempSync(join(tmpdir(), "ordinary-tmux-deleted-cwd-"));
  const cwd = vi.spyOn(process, "cwd").mockImplementation(() => {
    throw Object.assign(new Error("ENOENT: process.cwd failed, uv_cwd"), { code: "ENOENT" });
  });
  try {
    mkdirSync(join(directory, "bin"));
    writeFileSync(join(directory, "bin/tmux"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(directory, "bin/tmux"), 0o755);
    const selected = resolveOrdinaryTmuxClient({
      // A relative entry cannot be resolved without a current directory; it is skipped.
      PATH: ["relative-bin", join(directory, "bin")].join(":"),
      TMUX: "/private/socket,1,0",
    });
    expect(selected.executable).toBe(realpathSync(join(directory, "bin/tmux")));
  } finally {
    cwd.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});
