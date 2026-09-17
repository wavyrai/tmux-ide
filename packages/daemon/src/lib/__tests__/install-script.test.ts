import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
const installer = resolve("../../docs/public/install.sh");
function fixture(manager: "npm" | "pnpm" | "bun") {
  const root = mkdtempSync(join(tmpdir(), "tmux-installer-"));
  const bin = join(root, "bin");
  const packages = join(root, "global packages");
  const cli = join(packages, "tmux-ide/bin/cli.js");
  mkdirSync(bin);
  mkdirSync(join(packages, "tmux-ide/bin"), { recursive: true });
  const executable = (name: string, script: string) =>
    writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  symlinkSync(process.execPath, join(bin, "node"));
  executable("tmux", "exit 0");
  executable("tmux-ide", "echo stale-PATH-version; exit 0");
  writeFileSync(
    join(packages, "tmux-ide/package.json"),
    JSON.stringify({ name: "tmux-ide", version: "3.0.1" }),
  );
  writeFileSync(cli, 'console.log("tmux-ide v3.0.1");');
  const globalBin = join(root, "global bin");
  mkdirSync(globalBin);
  symlinkSync(cli, join(globalBin, "tmux-ide"));
  executable(
    manager,
    'printf "%s\\n" "$*" >> "$CALLS"\ncase "$*" in "root -g") printf "%s\\n" "$PACKAGES" ;; "pm bin -g") printf "%s\\n" "$GLOBAL_BIN" ;; esac',
  );
  const env = {
    PATH: bin,
    HOME: root,
    CALLS: join(root, "calls"),
    PACKAGES: packages,
    GLOBAL_BIN: globalBin,
  };
  return {
    root,
    cli,
    env,
    run: () =>
      execFileSync("/bin/sh", [installer], {
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
for (const manager of ["npm", "pnpm", "bun"] as const) {
  it(`verifies the exact ${manager} installed CLI despite stale PATH and never copies skills`, () => {
    const test = fixture(manager);
    try {
      const output = test.run();
      expect(output).toContain("tmux-ide v3.0.1 installed successfully");
      expect(output).not.toContain("stale-PATH-version");
      expect(output).toContain("optional .tmux-ide/workspace.yml");
      expect(readFileSync(test.env.CALLS, "utf8")).toBe(
        `${manager === "npm" ? "install" : "add"} -g tmux-ide@latest\n${manager === "bun" ? "pm bin -g" : "root -g"}\n`,
      );
    } finally {
      test.cleanup();
    }
  });
}
it("refuses missing or mismatched installed CLI even when stale PATH command exists", () => {
  const test = fixture("npm");
  try {
    writeFileSync(test.cli, 'console.log("tmux-ide v2.0.0");');
    expect(test.run).toThrow("version does not match");
    rmSync(test.cli);
    expect(test.run).toThrow("Installed CLI was not found");
  } finally {
    test.cleanup();
  }
});
it("rejects Node18 before invoking a package manager", () => {
  const test = fixture("npm");
  try {
    rmSync(join(test.env.PATH, "node"));
    writeFileSync(join(test.env.PATH, "node"), "#!/bin/sh\necho 18\n", { mode: 0o755 });
    expect(test.run).toThrow("Node.js 20+ is required");
    expect(() => readFileSync(test.env.CALLS)).toThrow();
  } finally {
    test.cleanup();
  }
});
