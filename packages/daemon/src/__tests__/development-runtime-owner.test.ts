import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { resolveDevelopmentInstance } from "../lib/development-instance.ts";
import {
  developmentWorktreeIdentity,
  readDevelopmentIdentity,
  writeDevelopmentRecord,
  developmentProcessIdentity,
} from "../lib/development-state.ts";
import {
  claimDevelopmentRuntimeOwner,
  verifyDevelopmentRuntimeOwner,
} from "../lib/development-runtime-owner.ts";
import { resetDevelopmentInstance } from "../lib/development-control.ts";
const execute = promisify(execFile);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "development-runtime-"));
  roots.push(root);
  const worktree = join(root, "tree");
  mkdirSync(worktree);
  execFileSync("git", ["init", "--quiet", worktree]);
  const instances = ["a", "b"].map((name) =>
    resolveDevelopmentInstance({ worktree, store: join(root, name) }),
  );
  roots.push(instances[0]!.runtimeDir);
  for (const instance of instances) {
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
  }
  return { root, instances };
}
it("atomically admits one store for the same tuple and protects its cwd/live app from the loser reset", async () => {
  const { root, instances } = await fixture();
  expect(instances[0]!.runtimeDir).toBe(instances[1]!.runtimeDir);
  const script = join(root, "claim.ts");
  const state = fileURLToPath(new URL("../lib/development-state.ts", import.meta.url));
  const runtime = fileURLToPath(new URL("../lib/development-runtime-owner.ts", import.meta.url));
  writeFileSync(
    script,
    `import { readDevelopmentIdentity } from ${JSON.stringify(state)};
import { claimDevelopmentRuntimeOwner } from ${JSON.stringify(runtime)};
void (async () => { try { const instance=JSON.parse(process.argv[2]); const identity=await readDevelopmentIdentity(instance); claimDevelopmentRuntimeOwner(instance, identity); console.log("won"); } catch { console.log("lost"); } })();`,
  );
  const tsx = fileURLToPath(new URL("../../../../node_modules/tsx/dist/cli.mjs", import.meta.url));
  const outcomes = await Promise.all(
    instances.map((instance) =>
      execute(process.execPath, ["--no-deprecation", tsx, script, JSON.stringify(instance)], {
        encoding: "utf8",
        timeout: 10000,
      }),
    ),
  );
  expect(outcomes.map((outcome) => outcome.stdout.trim()).sort()).toEqual(["lost", "won"]);
  const winnerIndex = outcomes.findIndex((outcome) => outcome.stdout.trim() === "won");
  const winner = instances[winnerIndex]!;
  const loser = instances[1 - winnerIndex]!;
  const cwd = join(winner.runtimeDir, "compiled-tui");
  mkdirSync(cwd, { mode: 0o700 });
  const marker = join(cwd, "owned-marker");
  writeFileSync(marker, "preserve");
  const apps = join(winner.root, "apps");
  mkdirSync(apps, { mode: 0o700 });
  const attempt = randomUUID();
  writeDevelopmentRecord(join(apps, `${attempt}.json`), {
    version: 1,
    attempt,
    managerPid: process.pid,
    managerIncarnation: "test",
    pid: process.pid,
    incarnation: await developmentProcessIdentity(process.pid),
    generation: `build-${randomUUID()}`,
  });
  await expect(resetDevelopmentInstance(loser, { yes: true })).rejects.toThrow("another store");
  expect(readFileSync(marker, "utf8")).toBe("preserve");
  expect(existsSync(join(apps, `${attempt}.json`))).toBe(true);
  expect(verifyDevelopmentRuntimeOwner(winner, (await readDevelopmentIdentity(winner))!)).toBe(
    true,
  );
  await expect(resetDevelopmentInstance(winner, { yes: true })).rejects.toThrow(
    "Close the managed app",
  );
});
it("refuses unmarked nonempty legacy runtime without creating an ownership receipt", async () => {
  const { instances } = await fixture();
  const instance = instances[0]!;
  mkdirSync(instance.runtimeDir, { recursive: true, mode: 0o700 });
  const marker = join(instance.runtimeDir, "legacy");
  writeFileSync(marker, "keep");
  const identity = (await readDevelopmentIdentity(instance))!;
  expect(() => claimDevelopmentRuntimeOwner(instance, identity)).toThrow("legacy");
  expect(readFileSync(marker, "utf8")).toBe("keep");
  expect(existsSync(join(instance.runtimeDir, "development-owner.json"))).toBe(false);
});
it("does not let a retained reset receipt reclaim another store after ownership transfer", async () => {
  const { instances } = await fixture();
  const [first, second] = instances;
  claimDevelopmentRuntimeOwner(first!, (await readDevelopmentIdentity(first!))!);
  await resetDevelopmentInstance(first!, { yes: true });
  expect(existsSync(join(first!.root, "reset.json"))).toBe(true);
  claimDevelopmentRuntimeOwner(second!, (await readDevelopmentIdentity(second!))!);
  const cwd = join(second!.runtimeDir, "compiled-tui");
  mkdirSync(cwd, { mode: 0o700 });
  const marker = join(cwd, "new-owner");
  writeFileSync(marker, "preserve");
  await expect(resetDevelopmentInstance(first!, { yes: true })).rejects.toThrow("another store");
  expect(readFileSync(marker, "utf8")).toBe("preserve");
  expect(verifyDevelopmentRuntimeOwner(second!, (await readDevelopmentIdentity(second!))!)).toBe(
    true,
  );
});
