import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as lifecycle from "../lib/development-lifecycle.ts";
import * as tmuxRead from "../lib/bounded-tmux-read.ts";
import { resolveDevelopmentInstance } from "../lib/development-instance.ts";
import {
  developmentProcessIdentity,
  developmentFailureResult,
  developmentStageError,
  DevelopmentOperationError,
  developmentWorktreeIdentity,
  writeDevelopmentRecord,
} from "../lib/development-state.ts";
import { withDevelopmentLock, recoverDevelopmentLock } from "../lib/development-lock.ts";
import {
  selectRecordedDevelopmentInstance,
  listDevelopmentInstances,
} from "../lib/development-selection.ts";
import {
  downDevelopmentInstance,
  resetDevelopmentInstance,
  restartDevelopmentInstance,
} from "../lib/development-control.ts";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "development-control-"));
  roots.push(root);
  const worktree = join(root, "tree");
  mkdirSync(worktree);
  execFileSync("git", ["init", "--quiet", worktree]);
  const instance = resolveDevelopmentInstance({ worktree, store: join(root, "store") });
  mkdirSync(instance.root, { recursive: true, mode: 0o700 });
  writeDevelopmentRecord(join(instance.root, "instance.json"), {
    version: 1,
    id: instance.id,
    digest: instance.digest,
    worktree: instance.worktree,
    name: instance.name,
    capability: randomUUID(),
    ...(await developmentWorktreeIdentity(instance)),
  });
  return { root, instance };
}
function lockRecord(path: string, pid = 2147483647) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  writeDevelopmentRecord(join(path, "owner.json"), {
    pid,
    incarnation: "dead-or-different",
    token: randomUUID(),
  });
}
it("recovers a proven-dead lock and crashed recoverer, without guessing from age", async () => {
  const { instance } = await fixture();
  const path = join(instance.root, "locks/lifecycle");
  lockRecord(path);
  lockRecord(join(path, "recovery"));
  expect(await recoverDevelopmentLock(instance, "lifecycle")).toBe(true);
  expect(existsSync(path)).toBe(false);
  lockRecord(path, process.pid);
  expect(await recoverDevelopmentLock(instance, "lifecycle")).toBe(false);
  expect(existsSync(path)).toBe(true);
});
it("protects incomplete legacy locks and live recovery markers", async () => {
  const { instance } = await fixture();
  const path = join(instance.root, "locks/build");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  expect(await recoverDevelopmentLock(instance, "build")).toBe(false);
  lockRecord(path);
  lockRecord(join(path, "recovery"), process.pid);
  expect(await recoverDevelopmentLock(instance, "build")).toBe(false);
  expect(existsSync(path)).toBe(true);
  writeDevelopmentRecord(join(path, "owner.json"), {
    pid: 2147483647,
    incarnation: { invalid: true },
    token: randomUUID(),
  });
  await expect(recoverDevelopmentLock(instance, "build")).rejects.toThrow(
    "Invalid development lock owner",
  );
  expect(existsSync(path)).toBe(true);
});
it("serializes concurrent lifecycle admission after stale recovery", async () => {
  const { instance } = await fixture();
  lockRecord(join(instance.root, "locks/lifecycle"));
  let concurrent = 0;
  let maximum = 0;
  await Promise.all(
    Array.from({ length: 4 }, () =>
      withDevelopmentLock(instance, "lifecycle", async () => {
        maximum = Math.max(maximum, ++concurrent);
        await new Promise((resolve) => setTimeout(resolve, 15));
        concurrent--;
      }),
    ),
  );
  expect(maximum).toBe(1);
});
it("selects an orphan only from its stored tuple and resets payload without deleting locks", async () => {
  const { root, instance } = await fixture();
  const sentinel = join(root, "sentinel");
  writeFileSync(sentinel, "keep");
  mkdirSync(instance.stateHome, { mode: 0o700 });
  writeFileSync(join(instance.stateHome, "owned"), "remove");
  renameSync(instance.worktree, `${instance.worktree}-moved`);
  expect(await listDevelopmentInstances(instance.store)).toMatchObject({
    instances: [{ id: instance.id, worktreeState: "missing" }],
  });
  const orphan = await selectRecordedDevelopmentInstance(instance.id, instance.store);
  await expect(resetDevelopmentInstance(orphan)).rejects.toThrow("--yes");
  expect(await downDevelopmentInstance(orphan)).toMatchObject({ status: "stopped" });
  expect(await resetDevelopmentInstance(orphan, { yes: true })).toMatchObject({ status: "reset" });
  expect(readdirSync(instance.root).sort()).toEqual(["locks", "reset.json"]);
  expect(readFileSync(sentinel, "utf8")).toBe("keep");
  expect(await selectRecordedDevelopmentInstance(instance.id, instance.store)).toEqual(orphan);
  await resetDevelopmentInstance(orphan, { yes: true });
});
it("protects a reused live PID across lifecycle actions", async () => {
  const { instance } = await fixture();
  writeDevelopmentRecord(join(instance.root, "owner.json"), {
    version: 1,
    attempt: randomUUID(),
    pid: process.pid,
    incarnation: "not-this-incarnation",
    generation: `build-${randomUUID()}`,
    manifestHash: "a".repeat(64),
  });
  const refusal = await downDevelopmentInstance(instance).catch((error) => error);
  expect(refusal).toBeInstanceOf(DevelopmentOperationError);
  expect(refusal.message).toContain("reused");
  expect(developmentFailureResult("down", refusal, instance)).toMatchObject({
    ok: false,
    reason: "owner-unverified",
    diagnostic: { stage: "owner-admission", category: "Error" },
  });
  expect(existsSync(join(instance.root, "owner.json"))).toBe(true);
  await expect(resetDevelopmentInstance(instance, { yes: true })).rejects.toThrow("reused");
  await expect(restartDevelopmentInstance(instance, { applyBuild: true })).rejects.toThrow(
    "Runtime ownership is unavailable",
  );
});
it("holds build then lifecycle through reset so a publisher cannot lose its generation", async () => {
  const { instance } = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const acquired = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocking = withDevelopmentLock(instance, "build", async () => {
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await acquired;
  const resetting = resetDevelopmentInstance(instance, { yes: true });
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(existsSync(join(instance.root, "instance.json"))).toBe(true);
  release();
  await blocking;
  await resetting;
  expect(existsSync(join(instance.root, "locks"))).toBe(true);
});

it("blocks reset for live and interrupted app admissions, then prunes proven-dead apps", async () => {
  const { instance } = await fixture();
  const attempt = randomUUID();
  const directory = join(instance.root, "apps");
  mkdirSync(directory, { mode: 0o700 });
  const path = join(directory, `${attempt}.json`);
  const record = {
    version: 1,
    attempt,
    managerPid: process.pid,
    managerIncarnation: "manager",
    pid: process.pid,
    incarnation: "different-incarnation",
    generation: `build-${randomUUID()}`,
  };
  writeDevelopmentRecord(path, record);
  await expect(resetDevelopmentInstance(instance, { yes: true })).rejects.toThrow(
    "App PID was reused",
  );
  writeDevelopmentRecord(path, { ...record, pid: null, incarnation: null });
  await expect(resetDevelopmentInstance(instance, { yes: true })).rejects.toThrow(
    "Interrupted app admission",
  );
  writeDevelopmentRecord(path, { ...record, pid: 2147483647, incarnation: "dead" });
  await expect(resetDevelopmentInstance(instance, { yes: true })).resolves.toMatchObject({
    status: "reset",
  });
});
it("retires a dead interrupted startup only after revoking its admission", async () => {
  const { instance } = await fixture();
  const attempt = randomUUID();
  const record = {
    version: 1,
    attempt,
    pid: 2147483647,
    incarnation: "dead",
    generation: `build-${randomUUID()}`,
    manifestHash: "b".repeat(64),
  };
  writeDevelopmentRecord(join(instance.root, "startup-process.json"), record);
  writeDevelopmentRecord(join(instance.root, "startup.json"), record);
  writeDevelopmentRecord(join(instance.root, `launch-${attempt}.json`), {
    version: 1,
    attempt,
    pid: record.pid,
  });
  await downDevelopmentInstance(instance, { daemonOnly: true });
  expect(existsSync(join(instance.root, "startup.json"))).toBe(false);
  expect(existsSync(join(instance.root, "startup-process.json"))).toBe(false);
  expect(existsSync(join(instance.root, `launch-${attempt}.json`))).toBe(false);
});
it("keeps a generation published after queued reset and never removes a replacement source tree", async () => {
  const { instance } = await fixture();
  renameSync(instance.worktree, `${instance.worktree}-old`);
  mkdirSync(instance.worktree);
  writeFileSync(join(instance.worktree, "unrelated"), "preserve");
  const selected = await selectRecordedDevelopmentInstance(instance.id, instance.store);
  let release!: () => void;
  let entered!: () => void;
  const acquired = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const holding = withDevelopmentLock(instance, "lifecycle", async () => {
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await acquired;
  const resetting = resetDevelopmentInstance(selected, { yes: true });
  await new Promise((resolve) => setTimeout(resolve, 60));
  const publishing = withDevelopmentLock(instance, "build", async () => {
    mkdirSync(join(instance.root, "artifacts"), { mode: 0o700 });
    writeFileSync(join(instance.root, "artifacts/new-generation"), "new");
  });
  release();
  await holding;
  await resetting;
  await publishing;
  expect(readFileSync(join(instance.root, "artifacts/new-generation"), "utf8")).toBe("new");
  expect(readFileSync(join(instance.worktree, "unrelated"), "utf8")).toBe("preserve");
});

it("returns action-specific CLI JSON for live apps, confirmation and missing stored IDs", async () => {
  const { instance } = await fixture();
  const repo = fileURLToPath(new URL("../../../../", import.meta.url));
  function rejected(args: string[]) {
    try {
      execFileSync(
        process.execPath,
        [
          "--no-deprecation",
          "--import",
          join(repo, "node_modules/tsx/dist/loader.mjs"),
          join(repo, "scripts/development-instance.ts"),
          ...args,
          "--store",
          instance.store,
          "--json",
        ],
        { encoding: "utf8", stdio: "pipe", timeout: 10000 },
      );
      throw new Error("Expected rejected CLI command");
    } catch (error) {
      const result = error as { status?: number; stdout?: string; stderr?: string };
      expect(result.status).toBe(1);
      expect(result.stderr).toBe("");
      return JSON.parse(result.stdout!);
    }
  }
  expect(rejected(["reset", "--worktree", instance.worktree])).toMatchObject({
    operation: "reset",
    reason: "confirmation-required",
  });
  expect(rejected(["status", "--id", `dev-${"0".repeat(24)}`])).toMatchObject({
    operation: "status",
    reason: "identity-unavailable",
  });
  expect(rejected(["restart", "--worktree", instance.worktree, "--apply-build"])).toMatchObject({
    operation: "restart",
    reason: "owner-unverified",
  });
  const attempt = randomUUID();
  mkdirSync(join(instance.root, "apps"), { mode: 0o700 });
  writeDevelopmentRecord(join(instance.root, "apps", `${attempt}.json`), {
    version: 1,
    attempt,
    managerPid: process.pid,
    managerIncarnation: "test-manager",
    pid: process.pid,
    incarnation: await developmentProcessIdentity(process.pid),
    generation: `build-${randomUUID()}`,
  });
  writeDevelopmentRecord(join(instance.root, "startup-receipt.json"), {
    status: "ready",
    secret: "credential-must-not-leak",
  });
  const refused = rejected(["reset", "--worktree", instance.worktree, "--yes"]);
  expect(refused).toMatchObject({ operation: "reset", reason: "app-live" });
  expect(refused).not.toHaveProperty("receipt");
  expect(JSON.stringify(refused)).not.toContain("credential-must-not-leak");
  expect(
    developmentFailureResult("down", new Error("Bearer credential-must-not-leak"), instance),
  ).toMatchObject({ reason: "operation-failed", operation: "down" });
  expect(
    JSON.stringify(
      developmentFailureResult("down", new Error("Bearer credential-must-not-leak"), instance),
    ),
  ).not.toContain("credential-must-not-leak");
});

it("refuses missing/replaced worktree activation before publishing a transition", async () => {
  const { instance } = await fixture();
  renameSync(instance.worktree, `${instance.worktree}-moved`);
  await expect(restartDevelopmentInstance(instance, { applyBuild: true })).rejects.toMatchObject({
    reason: "identity-unavailable",
  });
  expect(existsSync(join(instance.root, "activation.json"))).toBe(false);
  mkdirSync(instance.worktree);
  execFileSync("git", ["init", "--quiet", instance.worktree]);
  await expect(restartDevelopmentInstance(instance, { applyBuild: true })).rejects.toMatchObject({
    reason: "identity-unavailable",
  });
  expect(existsSync(join(instance.root, "activation.json"))).toBe(false);
});

it("projects only bounded fixed failure metadata and preserves typed reason/receipt", async () => {
  const { instance } = await fixture();
  const typed = new DevelopmentOperationError(
    "activation-failed",
    "Authored explanation",
    join(instance.root, "activation.json"),
  );
  const wrapped = developmentStageError(typed, "owner-wait");
  expect(wrapped.message).toBe("Authored explanation");
  expect(developmentFailureResult("restart", wrapped, instance)).toMatchObject({
    ok: false,
    reason: "activation-failed",
    receipt: join(instance.root, "activation.json"),
    diagnostic: { stage: "owner-wait", category: "Error" },
  });
  expect(developmentFailureResult("down", wrapped, instance)).not.toHaveProperty("receipt");
  const raw = Object.assign(new TypeError("Bearer private-token"), {
    code: "ECONNRESET",
    cause: { code: "UND_ERR_SOCKET", cause: { code: "private-token" } },
    diagnostic: { stage: "private-token" },
    command: "private-token",
  });
  expect(developmentStageError(raw, "owner-request").message).toBe("Development operation failed");
  const result = developmentFailureResult("down", developmentStageError(raw, "owner-request"));
  expect(result).toMatchObject({
    reason: "operation-failed",
    diagnostic: {
      stage: "owner-request",
      category: "TypeError",
      code: "ECONNRESET",
      causeCode: "UND_ERR_SOCKET",
    },
  });
  expect(JSON.stringify(result)).not.toContain("private-token");
});

it.each([
  null,
  "Bearer private-token",
  999,
  { name: "private-token", code: "TOKEN_VALUE", cause: { code: "SECRET" } },
])("redacts nonstandard thrown values %#", (value) => {
  const result = developmentFailureResult("down", developmentStageError(value, "tmux-command"));
  expect(result).toMatchObject({
    ok: false,
    reason: "operation-failed",
    diagnostic: { stage: "tmux-command", category: "unknown" },
  });
  expect(result.diagnostic).not.toHaveProperty("code");
  expect(result.diagnostic).not.toHaveProperty("causeCode");
  expect(JSON.stringify(result)).not.toMatch(/private-token|TOKEN_VALUE|SECRET/);
});

it("bounds child exits and ignores getters and unauthored diagnostic properties", () => {
  for (const code of [1, -1, 255])
    expect(
      developmentFailureResult("down", developmentStageError({ code }, "tmux-command")).diagnostic
        ?.code,
    ).toBe(code);
  for (const code of [256, -256, NaN, Infinity, 1.5, "1"])
    expect(
      developmentFailureResult("down", developmentStageError({ code }, "tmux-command")).diagnostic,
    ).not.toHaveProperty("code");
  const raw = Object.defineProperty({}, "code", {
    get() {
      throw Error("private-token");
    },
  });
  expect(
    developmentFailureResult("down", developmentStageError(raw, "socket-remove")).diagnostic,
  ).not.toHaveProperty("code");
  expect(
    developmentFailureResult("down", { diagnostic: { stage: "tmux-command", code: "ENOENT" } }),
  ).not.toHaveProperty("diagnostic");
});

it("reports identity and tmux ownership stages without retiring protected records", async () => {
  const { instance } = await fixture();
  const identityPath = join(instance.root, "instance.json");
  const identity = readFileSync(identityPath);
  rmSync(identityPath);
  let failure = await downDevelopmentInstance(instance).catch((error) => error);
  expect(developmentFailureResult("down", failure, instance)).toMatchObject({
    reason: "identity-unavailable",
    diagnostic: { stage: "identity" },
  });
  writeFileSync(identityPath, identity, { mode: 0o600 });
  writeDevelopmentRecord(join(instance.root, "tmux.json"), { unsafe: "private-token" });
  writeDevelopmentRecord(join(instance.root, "startup.json"), { preserve: true });
  failure = await downDevelopmentInstance(instance).catch((error) => error);
  expect(developmentFailureResult("down", failure, instance)).toMatchObject({
    ok: false,
    reason: "operation-failed",
    diagnostic: { stage: "tmux-identity" },
  });
  expect(JSON.stringify(developmentFailureResult("down", failure, instance))).not.toContain(
    "private-token",
  );
  expect(existsSync(join(instance.root, "startup.json"))).toBe(true);
});

it("reports the actual tmux command rejection without waiting, removing socket, or retiring admission", async () => {
  const { instance } = await fixture();
  const identity = JSON.parse(readFileSync(join(instance.root, "instance.json"), "utf8"));
  writeDevelopmentRecord(join(instance.root, "startup.json"), { preserve: true });
  const read = vi.spyOn(lifecycle, "readTmux").mockReturnValue({
    pid: process.pid,
    incarnation: await developmentProcessIdentity(process.pid),
    capability: identity.capability,
    executable: "/unused-fixture",
    socket: { path: "/unused-fixture" },
  } as ReturnType<typeof lifecycle.readTmux>);
  const verify = vi.spyOn(lifecycle, "verifyTmux").mockResolvedValue(undefined);
  const command = vi
    .spyOn(tmuxRead, "boundedTmuxRead")
    .mockRejectedValue(Object.assign(new Error("secret command args"), { code: 1 }));
  try {
    const failure = await downDevelopmentInstance(instance).catch((error) => error);
    expect(developmentFailureResult("down", failure, instance)).toMatchObject({
      ok: false,
      reason: "operation-failed",
      diagnostic: { stage: "tmux-command", category: "Error", code: 1 },
    });
    expect(command).toHaveBeenCalledOnce();
    expect(existsSync(join(instance.root, "startup.json"))).toBe(true);
    expect(JSON.stringify(developmentFailureResult("down", failure, instance))).not.toContain(
      "secret",
    );
  } finally {
    read.mockRestore();
    verify.mockRestore();
    command.mockRestore();
  }
});

it("filters forged typed diagnostic fields without invoking getters", () => {
  let invoked = false;
  const diagnostic = Object.defineProperty(
    { stage: "tmux-command", category: "secret", causeCode: "secret" },
    "code",
    {
      get() {
        invoked = true;
        throw Error("secret");
      },
    },
  );
  const error = new DevelopmentOperationError(
    "owner-unverified",
    "Owned explanation",
    undefined,
    diagnostic as never,
  );
  expect(developmentFailureResult("down", error).diagnostic).toEqual({
    stage: "tmux-command",
    category: "unknown",
  });
  expect(invoked).toBe(false);
  const invalid = new DevelopmentOperationError(
    "owner-unverified",
    "Owned explanation",
    undefined,
    { stage: "secret", category: "Error" } as never,
  );
  expect(developmentFailureResult("down", invalid)).not.toHaveProperty("diagnostic");
});
