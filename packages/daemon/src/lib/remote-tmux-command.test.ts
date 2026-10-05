import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { remoteTmuxIdeCommand } from "./remote-tmux-command.ts";

it.each(["discover", "start"] as const)(
  "finds the user installer from a noninteractive PATH for %s",
  (operation) => {
    const root = mkdtempSync(join(tmpdir(), "remote-path-"));
    const home = join(root, "home with ' quotes $dollars");
    const bin = join(home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "tmux-ide"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    writeFileSync(join(home, ".profile"), "exit 97\n");
    const env = { HOME: home, PATH: "/usr/bin:/bin" };
    try {
      expect(
        spawnSync("/bin/sh", ["-c", "tmux-ide remote-daemon-info --json"], { env }).status,
      ).toBe(127);
      const result = execFileSync("/bin/sh", ["-c", remoteTmuxIdeCommand(operation)], {
        env,
        encoding: "utf8",
      });
      expect(result.trim().split("\n")).toEqual(
        operation === "discover"
          ? ["remote-daemon-info", "--json"]
          : ["update", "--daemon", "--json"],
      );
      const preferred = join(root, "preferred");
      mkdirSync(preferred);
      writeFileSync(join(preferred, "tmux-ide"), '#!/bin/sh\nprintf "preferred\\n"\n', {
        mode: 0o755,
      });
      expect(
        execFileSync("/bin/sh", ["-c", remoteTmuxIdeCommand(operation)], {
          env: { ...env, PATH: `${preferred}:/usr/bin:/bin` },
          encoding: "utf8",
        }).trim(),
      ).toBe("preferred");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
