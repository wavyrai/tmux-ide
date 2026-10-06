import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
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
    expect(resolveOrdinaryTmuxClient({ PATH: "" }, directory).executable).toBe(
      realpathSync(join(directory, "tmux")),
    );
    // Missing PATH uses the OS default search, not the explicit-empty cwd rule.
    try {
      expect(resolveOrdinaryTmuxClient({}, directory).executable).not.toBe(
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
