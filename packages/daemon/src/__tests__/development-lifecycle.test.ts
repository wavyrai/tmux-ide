import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  lstatSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveDevelopmentInstance } from "../lib/development-instance.ts";
import {
  developmentWorktreeIdentity,
  readDevelopmentIdentity,
  writeDevelopmentRecord,
  cleanManagerEnvironment,
} from "../lib/development-state.ts";
import { claimManagedDevelopmentLaunch } from "../lib/development-owner.ts";
import { statusDevelopmentInstance, upDevelopmentInstance } from "../lib/development-lifecycle.ts";
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dev-lifecycle-"));
  roots.push(root);
  const worktree = join(root, "tree");
  mkdirSync(worktree);
  execFileSync("git", ["init", "--quiet", worktree]);
  const instance = resolveDevelopmentInstance({ worktree, store: join(root, "store") });
  return { root, instance };
}
it("status is read-only when missing and doesn't disclose credentials", async () => {
  const { root, instance } = fixture();
  const before = readdirSync(root);
  const status = await statusDevelopmentInstance(instance);
  expect(status).toMatchObject({ state: "missing", reason: "selected-build-unavailable" });
  expect(readdirSync(root)).toEqual(before);
  expect(JSON.stringify(status)).not.toMatch(/authToken|capability|Bearer/u);
});
it.each([NaN, Infinity, -1, 0, 30001])(
  "rejects invalid startup timeout %s before making state",
  async (timeoutMs) => {
    const { instance } = fixture();
    await expect(upDevelopmentInstance(instance, { timeoutMs })).rejects.toThrow("timeoutMs");
    expect(existsSync(instance.root)).toBe(false);
  },
);
it("records a redacted failed receipt for missing build without starting resources", async () => {
  const { instance } = fixture();
  await expect(upDevelopmentInstance(instance)).rejects.toThrow("build-validation");
  const receipt = JSON.parse(readFileSync(join(instance.root, "startup-receipt.json"), "utf8"));
  expect(receipt).toMatchObject({ status: "failed", reason: "build-validation" });
  const identity = await readDevelopmentIdentity(instance);
  expect(identity).not.toBeNull();
  expect(JSON.stringify(receipt)).not.toContain(identity!.capability);
  expect(existsSync(join(instance.runtimeDir, "tmux.sock"))).toBe(false);
});
it("detects replacement of a worktree at the same pathname", async () => {
  const { instance } = fixture();
  mkdirSync(instance.root, { recursive: true, mode: 0o700 });
  const data = {
    version: 1,
    id: instance.id,
    digest: instance.digest,
    worktree: instance.worktree,
    name: instance.name,
    capability: randomUUID(),
    ...(await developmentWorktreeIdentity(instance)),
  };
  writeDevelopmentRecord(join(instance.root, "instance.json"), data);
  renameSync(instance.worktree, `${instance.worktree}-old`);
  mkdirSync(instance.worktree);
  execFileSync("git", ["init", "--quiet", instance.worktree]);
  await expect(readDevelopmentIdentity(instance)).rejects.toThrow("identity changed");
  expect(await statusDevelopmentInstance(instance)).toMatchObject({
    state: "blocked",
    reason: "instance-identity-invalid",
  });
});
it("clears inherited production/sibling and Git authority while preserving real HOME", () => {
  expect(
    cleanManagerEnvironment({
      HOME: "/real/home",
      PATH: "/bin",
      TMUX: "/production,1,0",
      TMUX_PANE: "%2",
      TMUX_IDE_HOME: "/canonical",
      TMUX_IDE_DEVELOPMENT_ID: "sibling",
      GIT_DIR: "/other/git",
      NODE_OPTIONS: "--require /other",
    }),
  ).toEqual({ HOME: "/real/home", PATH: "/bin" });
});

it("consumes a launch attempt exactly once without overwriting a live owner", async () => {
  const { instance } = fixture();
  mkdirSync(instance.root, { recursive: true, mode: 0o700 });
  const attempt = randomUUID();
  const outcomes = await Promise.allSettled([
    claimManagedDevelopmentLaunch(instance, attempt),
    claimManagedDevelopmentLaunch(instance, attempt),
  ]);
  expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  await expect(claimManagedDevelopmentLaunch(instance, attempt)).rejects.toThrow();
  const owner = {
    version: 1,
    attempt,
    pid: process.pid,
    incarnation: "protected",
    generation: `build-${randomUUID()}`,
    manifestHash: "a".repeat(64),
  };
  writeDevelopmentRecord(join(instance.root, "owner.json"), owner);
  const before = readFileSync(join(instance.root, "owner.json"), "utf8");
  const duplicate = randomUUID();
  await expect(claimManagedDevelopmentLaunch(instance, duplicate)).rejects.toThrow("protected");
  expect(readFileSync(join(instance.root, "owner.json"), "utf8")).toBe(before);
  expect(existsSync(join(instance.root, `launch-${duplicate}.json`))).toBe(false);
});

it("protects an unrecorded dangling socket alias and keeps status read-only", async () => {
  const { instance } = fixture();
  await expect(upDevelopmentInstance(instance)).rejects.toThrow("build-validation");
  mkdirSync(instance.runtimeDir, { recursive: true, mode: 0o700 });
  roots.push(instance.runtimeDir);
  const socket = join(instance.runtimeDir, "tmux.sock");
  symlinkSync(join(instance.root, "missing-socket-target"), socket);
  expect(await statusDevelopmentInstance(instance)).toMatchObject({
    state: "blocked",
    reason: "tmux-owner-invalid",
  });
  await expect(upDevelopmentInstance(instance)).rejects.toThrow("tmux-owner-invalid");
  expect(lstatSync(socket).isSymbolicLink()).toBe(true);
});
