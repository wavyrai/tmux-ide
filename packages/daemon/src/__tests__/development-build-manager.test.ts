import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  discoverDevelopmentWorktree,
  resolveDevelopmentInstance,
} from "../lib/development-instance.ts";
import {
  buildDevelopmentInstance,
  parseDevelopmentCapabilities,
  developmentSourceSnapshot,
} from "../lib/development-build-manager.ts";
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "development-manager-"));
  roots.push(root);
  const tree = join(root, "tree with spaces");
  mkdirSync(tree);
  mkdirSync(join(root, "home"));
  execFileSync("git", ["init", "--quiet", tree]);
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "isolated fixture",
    ],
    { cwd: tree },
  );
  writeFileSync(join(tree, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  const instance = resolveDevelopmentInstance({
    worktree: tree,
    store: join(root, "store"),
    userHome: join(root, "home"),
  });
  return { root, tree, instance };
}
it("captures relevant untracked inputs, modes and deletion without hashing generated CLI", async () => {
  const f = fixture();
  mkdirSync(join(f.tree, "scripts"));
  mkdirSync(join(f.tree, "bin"));
  const before = await developmentSourceSnapshot(f.tree);
  const source = join(f.tree, "scripts", "space ' name.ts");
  writeFileSync(source, "a");
  const after = await developmentSourceSnapshot(f.tree);
  expect(after.digest).not.toBe(before.digest);
  expect(after.dirty).toBe(true);
  writeFileSync(join(f.tree, "bin/cli.js"), "mutable generated output");
  expect((await developmentSourceSnapshot(f.tree)).digest).toBe(after.digest);
  chmodSync(source, 0o755);
  expect((await developmentSourceSnapshot(f.tree)).digest).not.toBe(after.digest);
  chmodSync(source, 0o644);
  rmSync(source);
  expect((await developmentSourceSnapshot(f.tree)).digest).toBe(before.digest);
  writeFileSync(source, "b");
  expect((await developmentSourceSnapshot(f.tree)).digest).not.toBe(after.digest);
});
it("cancels admission behind an unknown build lock without retiring its owner", async () => {
  const f = fixture();
  const lock = join(f.instance.root, "locks/build");
  mkdirSync(lock, { recursive: true, mode: 0o700 });
  writeFileSync(join(lock, "owner.json"), "unknown-owner");
  const abort = new AbortController();
  const pending = buildDevelopmentInstance(f.instance, { bun: "/not-used", signal: abort.signal });
  abort.abort(new Error("cancelled fixture"));
  await expect(pending).rejects.toThrow("cancelled fixture");
  expect(readFileSync(join(lock, "owner.json"), "utf8")).toBe("unknown-owner");
});
it("removes its own build lock after pre-build validation failure", async () => {
  const f = fixture();
  await expect(
    buildDevelopmentInstance(f.instance, { bun: join(f.root, "missing-bun") }),
  ).rejects.toThrow();
  expect(() => readFileSync(join(f.instance.root, "locks/build/owner.json"))).toThrow();
});

it("ignores inherited Git authority from a sibling checkout", async () => {
  const first = fixture();
  const second = fixture();
  writeFileSync(join(second.tree, "pnpm-lock.yaml"), "sibling lockfile");
  const before = await developmentSourceSnapshot(first.tree);
  vi.stubEnv("GIT_DIR", join(second.tree, ".git"));
  vi.stubEnv("GIT_WORK_TREE", second.tree);
  vi.stubEnv("GIT_INDEX_FILE", join(second.tree, ".git/index"));
  expect(discoverDevelopmentWorktree(first.tree)).toBe(first.instance.worktree);
  expect(await developmentSourceSnapshot(first.tree)).toEqual(before);
});

it("derives managed-owner capability from the compiled artifact probe, never old help text", () => {
  expect(parseDevelopmentCapabilities("tmux-ide usage and help")).toEqual([]);
  expect(parseDevelopmentCapabilities(JSON.stringify({ version: 1, capabilities: [] }))).toEqual(
    [],
  );
  expect(
    parseDevelopmentCapabilities(
      JSON.stringify({ version: 1, capabilities: ["managed-development-owner-v1"] }),
    ),
  ).toEqual(["managed-development-owner-v1"]);
});

it("retains actionable bounded private build diagnostics without exposing stderr publicly", async () => {
  const f = fixture();
  const bun = join(f.root, "failing-bun");
  writeFileSync(
    bun,
    "#!/bin/sh\ni=0; while [ $i -lt 4000 ]; do printf 'private-compiler-fixture Bearer example-secret\\n' >&2; i=$((i+1)); done\nexit 1\n",
    { mode: 0o700 },
  );
  let failure: unknown;
  try {
    await buildDevelopmentInstance(f.instance, { bun });
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    reason: "build-failed",
    receipt: join(f.instance.root, "build-receipt.json"),
  });
  expect((failure as Error).message).not.toContain("example-secret");
  const receipt = JSON.parse(readFileSync(join(f.instance.root, "build-receipt.json"), "utf8"));
  expect(receipt).toMatchObject({
    status: "failed",
    phase: "source-and-toolchain",
    logFailed: false,
  });
  expect(JSON.stringify(receipt)).not.toContain("example-secret");
  const log = readFileSync(join(f.instance.root, "logs/build.log"));
  expect(log.byteLength).toBeLessThanOrEqual(65536);
  expect(log.toString()).toContain("private-compiler-fixture");
});
