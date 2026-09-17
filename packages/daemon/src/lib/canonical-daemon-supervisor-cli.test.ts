import { afterEach, beforeEach, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const source = fileURLToPath(new URL("../../../../", import.meta.url));
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "supervisor-cli-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function cli(args: string[]) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("TMUX_IDE_") &&
        !["TMUX", "NODE_OPTIONS", "NODE_PATH", "BASH_ENV", "ENV", "ZDOTDIR"].includes(key),
    ),
  );
  return spawnSync(
    process.execPath,
    ["--import", "tsx", join(source, "bin/cli.ts"), ...args, "--json"],
    {
      cwd: source,
      env: {
        ...env,
        HOME: root,
        ZDOTDIR: root,
        TMUX_IDE_DAEMON_INFO_DIR: root,
        TMUX_IDE_REGISTRY_DIR: root,
        TMUX_IDE_SETTINGS_DIR: root,
      },
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 16384,
    },
  );
}
it("explicit reserve is idempotent and release requires confirmation and exact ID", () => {
  expect(cli(["daemon", "reserve-supervisor", "fixture"]).status).toBe(0);
  const path = join(root, "daemon.json"),
    before = readFileSync(path, "utf8");
  expect(cli(["daemon", "reserve-supervisor", "fixture"]).status).toBe(0);
  expect(readFileSync(path, "utf8")).toBe(before);
  for (const args of [
    ["daemon", "release-supervisor", "fixture"],
    ["daemon", "release-supervisor", "wrong", "--yes"],
  ]) {
    expect(cli(args).status).not.toBe(0);
    expect(readFileSync(path, "utf8")).toBe(before);
  }
  const release = cli(["daemon", "release-supervisor", "fixture", "--yes"]);
  expect(release.status).toBe(0);
  expect(JSON.parse(release.stdout)).toEqual({
    ok: true,
    status: "released",
    supervisionId: "fixture",
  });
  expect(existsSync(path)).toBe(false);
});
it("supervised headless rejects absent or wrong registration before older-owner retirement", () => {
  const missing = cli(["--headless", "--supervised", "fixture"]);
  expect(missing.status).toBe(1);
  expect(missing.stdout + missing.stderr).toContain("Matching supervisor reservation required");
  expect(existsSync(join(root, "daemon.json"))).toBe(false);
  const record = {
    pid: process.pid,
    port: 9,
    protocolVersion: 1,
    productVersion: "1.0.0",
    instanceId: "11111111-1111-4111-8111-111111111111",
    startedAt: new Date().toISOString(),
    bindHostname: "127.0.0.1",
    authToken: "private",
    supervisionId: "other",
  };
  writeFileSync(join(root, "daemon.json"), JSON.stringify(record), { mode: 0o600 });
  const before = readFileSync(join(root, "daemon.json"), "utf8");
  const wrong = cli(["--headless", "--supervised", "fixture"]);
  expect(wrong.status).toBe(1);
  expect(wrong.stdout + wrong.stderr).toContain("Matching supervisor reservation required");
  expect(readFileSync(join(root, "daemon.json"), "utf8")).toBe(before);
});
it("supervised flag cannot silently affect another command and fresh ordinary if-running remains no-op", () => {
  expect(cli(["status", "--supervised", "fixture"]).status).toBe(2);
  const result = cli(["update", "--daemon", "--if-running"]);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ ok: true, status: "not-running" });
  expect(existsSync(join(root, "daemon.json"))).toBe(false);
});
