import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  renameSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { developmentWorktreeIdentity, writeDevelopmentRecord } from "../lib/development-state.ts";
import { resolveDevelopmentInstance } from "../lib/development-instance.ts";
import {
  developmentLogs,
  developmentDiagnostics,
  projectDevelopmentLogRecords,
  safeDevelopmentText,
} from "../lib/development-diagnostics.ts";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dev-diagnostics-"));
  roots.push(root);
  const worktree = join(root, "tree");
  mkdirSync(worktree);
  execFileSync("git", ["init", "--quiet", worktree]);
  const instance = resolveDevelopmentInstance({ worktree, store: join(root, "store") });
  mkdirSync(join(instance.root, "logs"), { recursive: true, mode: 0o700 });
  return instance;
}
const event = {
  ts: "2026-09-16T10:00:00.000Z",
  level: "error",
  component: "daemon",
  msg: "Bearer hidden",
  code: "operation_capacity",
  reason: "admission_queue_full",
};
it("exports only complete bounded allowlisted records; drops arbitrary messages, metadata and secrets", () => {
  const secret = "11111111-1111-4111-8111-111111111111";
  const line = JSON.stringify({
    ...event,
    operationId: secret,
    token: secret,
    data: { bearer: secret },
  });
  const result = projectDevelopmentLogRecords(
    `${Array(300).fill(line).join("\n")}\nraw ${secret}\npartial ${secret}`,
    [secret],
  );
  expect(result.records).toHaveLength(128);
  expect(result.skipped).toBe(174);
  expect(result.records[0]).toMatchObject({
    code: "operation_capacity",
    reason: "admission_queue_full",
    message: "[omitted]",
  });
  expect(JSON.stringify(result)).not.toMatch(/hidden|11111111|bearer|token|partial/);
});
it("redacts known credentials before truncation and strips terminal controls", () => {
  const result = safeDevelopmentText(
    "\x1b] title Bearer abc token=def ?lease_ticket=xyz capability=cap known-secret\n",
    ["known-secret"],
  );
  expect(result).not.toMatch(/abc|def|xyz|cap\s|known-secret/);
  expect(result).not.toContain(String.fromCharCode(27));
  expect(result).not.toContain("\n");
  expect(safeDevelopmentText("a".repeat(2000))).toHaveLength(1024);
});
it("log read bounds bytes, excludes split tails and never reads a sibling symlink", async () => {
  const instance = fixture();
  const path = join(instance.root, "logs/owner.log");
  writeFileSync(
    path,
    "prefix-token".repeat(7000) + "\n" + JSON.stringify(event) + "\nunfinished-secret",
    { mode: 0o600 },
  );
  const result = await developmentLogs(instance);
  expect(result).toMatchObject({ readBytes: 65536, truncated: true, partialFragments: 2 });
  expect(result.records).toHaveLength(1);
  expect(JSON.stringify(result)).not.toMatch(/prefix-token|unfinished-secret|hidden/);
  rmSync(path);
  const sibling = join(instance.root, "sibling.log");
  writeFileSync(sibling, JSON.stringify(event), { mode: 0o600 });
  symlinkSync(sibling, path);
  await expect(developmentLogs(instance)).rejects.toThrow("unsafe");
});
it("missing builds and unavailable source are explicit without creating runtime state", async () => {
  const instance = fixture();
  const result = await developmentDiagnostics(instance);
  expect(result).toMatchObject({
    state: "missing",
    reason: "selected-build-unavailable",
    manager: {
      node: process.version,
      nodeAbi: process.versions.modules,
      platform: process.platform,
      arch: process.arch,
    },
    sourceUnavailable: true,
    source: null,
    selected: null,
    active: null,
    tui: { recordedLaunches: [] },
  });
  expect(JSON.stringify(result)).not.toMatch(/authToken|capability|Bearer/);
});

it("does not attribute source at a replaced worktree path to a recorded instance", async () => {
  const instance = fixture();
  writeFileSync(join(instance.worktree, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  execFileSync("git", ["-C", instance.worktree, "add", "."]);
  execFileSync("git", [
    "-C",
    instance.worktree,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  writeDevelopmentRecord(join(instance.root, "instance.json"), {
    version: 1,
    id: instance.id,
    digest: instance.digest,
    worktree: instance.worktree,
    name: instance.name,
    capability: "11111111-1111-4111-8111-111111111111",
    ...(await developmentWorktreeIdentity(instance)),
  });
  renameSync(instance.worktree, `${instance.worktree}-old`);
  cpSync(`${instance.worktree}-old`, instance.worktree, { recursive: true });
  const result = await developmentDiagnostics(instance);
  expect(result.source).toBeNull();
  expect(result.sourceUnavailable).toBe(true);
});
