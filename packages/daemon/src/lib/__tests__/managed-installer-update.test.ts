import { test, expect } from "vitest";
import {
  mkdtempSync,
  realpathSync,
  unlinkSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { managedInstallerPrefix, runManagedInstallerUpdate } from "../managed-installer-update.ts";
import { planUpdate, runUpdate } from "../update.ts";

function fixture() {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "managed-update-")));
  const prefix = join(temp, "space ' $literal");
  const root = join(prefix, "share/tmux-ide");
  const release = join(root, "releases/install-ABC123");
  const cli = join(release, "npm/lib/node_modules/tmux-ide/bin");
  mkdirSync(cli, { recursive: true });
  mkdirSync(join(prefix, "bin"));
  writeFileSync(join(cli, "../package.json"), JSON.stringify({ name: "tmux-ide" }));
  writeFileSync(join(root, "installer-v1"), "1\n");
  writeFileSync(join(release, ".installer-release-v1"), "1\n");
  writeFileSync(join(prefix, "bin/tmux-ide"), "#!/bin/sh\n# tmux-ide universal installer v1\n");
  symlinkSync(release, join(root, "current"));
  return { temp, prefix, root, release, cli };
}

test("managed update dry run preserves prefix and beta channel without downloading", () => {
  const f = fixture();
  try {
    const output: string[] = [];
    runUpdate(
      { cliDir: f.cli, dryRun: true, json: true },
      {
        currentVersion: () => "3.0.0-beta.1",
        status: () => ({ latest: "3.0.0-beta.2", updateAvailable: true }),
        execute: (() => {
          throw new Error("dry run executed");
        }) as typeof execFileSync,
        output: (line) => output.push(line),
      },
    );
    expect(JSON.parse(output[0]!)).toMatchObject({
      installerPrefix: f.prefix,
      channel: "beta",
      executed: false,
    });
    expect(planUpdate({ cliPath: f.cli, gitRoot: null, currentVersion: "3.0.0" }).channel).toBe(
      "latest",
    );
    unlinkSync(join(f.root, "current"));
    expect(managedInstallerPrefix(f.cli)).toBeNull();
    const otherRelease = join(f.root, "releases/install-DEF456");
    mkdirSync(otherRelease);
    symlinkSync(otherRelease, join(f.root, "current"));
    expect(
      planUpdate({ cliPath: f.cli, gitRoot: null, currentVersion: "3.0.0" }).command,
    ).toBeNull();
  } finally {
    rmSync(f.temp, { recursive: true, force: true });
  }
});

test("unmarked release never gets an executable managed update plan", () => {
  const f = fixture();
  try {
    rmSync(join(f.release, ".installer-release-v1"));
    expect(
      planUpdate({ cliPath: f.cli, gitRoot: null, currentVersion: "3.0.0" }).command,
    ).toBeNull();
  } finally {
    rmSync(f.temp, { recursive: true, force: true });
  }
});

test("installer receives literal prefix and channel; temporary download is removed", () => {
  const f = fixture();
  let downloaded = "";
  const result = join(f.temp, "args");
  try {
    const execute = ((command: string, args: string[], options: object) => {
      if (command === "curl") {
        downloaded = args[args.indexOf("--output") + 1]!;
        writeFileSync(downloaded, '#!/bin/sh\nprintf "%s\\n" "$@" > "$UPDATE_TEST_RESULT"\n');
        return Buffer.alloc(0);
      }
      return execFileSync(command, args, {
        ...options,
        env: { ...process.env, UPDATE_TEST_RESULT: result },
      });
    }) as typeof execFileSync;
    const output: string[] = [];
    runUpdate(
      { cliDir: f.cli, dryRun: false, json: true },
      {
        execute,
        output: (line) => output.push(line),
        currentVersion: () => "3.0.0-beta.1",
        status: () => ({ latest: "3.0.0-beta.2", updateAvailable: true }),
      },
    );
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toMatchObject({
      method: "installer",
      executed: true,
      installerPrefix: f.prefix,
      channel: "beta",
    });
    expect(readFileSync(result, "utf8")).toBe(`--prefix\n${f.prefix}\n--version\nbeta\n`);
    expect(existsSync(downloaded)).toBe(false);
  } finally {
    rmSync(f.temp, { recursive: true, force: true });
  }
});

for (const failure of ["download", "html", "syntax", "install"]) {
  test(`failed ${failure} propagates and cleans download without changing current release`, () => {
    const f = fixture();
    let downloaded = "";
    try {
      const execute = ((command: string, args: string[], options: object) => {
        if (command === "curl") {
          downloaded = args[args.indexOf("--output") + 1]!;
          if (failure === "download") throw new Error("network failure");
          writeFileSync(
            downloaded,
            failure === "html"
              ? "<html>unavailable</html>"
              : failure === "syntax"
                ? "#!/bin/sh\nif\n"
                : "#!/bin/sh\nexit 7\n",
          );
          return Buffer.alloc(0);
        }
        return execFileSync(command, args, { ...options, stdio: "pipe" });
      }) as typeof execFileSync;
      expect(() => runManagedInstallerUpdate(f.prefix, "latest", true, execute)).toThrow();
      expect(managedInstallerPrefix(f.cli)).toBe(f.prefix);
      expect(existsSync(downloaded)).toBe(false);
    } finally {
      rmSync(f.temp, { recursive: true, force: true });
    }
  });
}
