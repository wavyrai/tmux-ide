import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
const mocks = vi.hoisted(() => ({
  ready: vi.fn(),
  build: vi.fn(),
  read: vi.fn(),
  launch: vi.fn(),
  prepare: vi.fn(),
}));
vi.mock("../lib/development-container.ts", async (original) => ({
  ...(await original<typeof import("../lib/development-container.ts")>()),
  withReadyDevelopmentContainer: mocks.ready,
}));
vi.mock("../lib/development-build-manager.ts", async (original) => ({
  ...(await original<typeof import("../lib/development-build-manager.ts")>()),
  buildDevelopmentInstance: mocks.build,
}));
vi.mock("../lib/development-build.ts", async (original) => ({
  ...(await original<typeof import("../lib/development-build.ts")>()),
  readDevelopmentBuild: mocks.read,
}));
vi.mock("../lib/development-app.ts", async (original) => ({
  ...(await original<typeof import("../lib/development-app.ts")>()),
  launchDevelopmentApp: mocks.launch,
  prepareDevelopmentAppRemote: mocks.prepare,
}));
import { launchDevelopmentContainerApp } from "../lib/development-container-app.ts";
import { developmentContainerClient } from "../lib/development-container.ts";
import { resolveDevelopmentComposeProject } from "../lib/development-compose.ts";
const roots: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "container-app-launch-")));
  roots.push(root);
  const tree = join(root, "tree");
  mkdirSync(tree);
  execFileSync("git", ["init", "-q", tree]);
  const project = resolveDevelopmentComposeProject({
    worktree: tree,
    name: "remote",
    store: join(root, "store"),
  });
  const client = developmentContainerClient(project);
  const target = {
    alias: project.name,
    controlRoot: project.controlRoot,
    configHash: "a".repeat(64),
  };
  let locked = false;
  mocks.ready.mockImplementation(async (_project, action) => {
    locked = true;
    try {
      return await action(target);
    } finally {
      locked = false;
    }
  });
  mocks.prepare.mockImplementation((value) => ({ ...value, directory: "/private/wrapper" }));
  mocks.launch.mockImplementation(async (instance, remote) => {
    expect(locked).toBe(true);
    expect(instance.id).toBe(client.id);
    expect(remote.alias).toBe(project.name);
    return { completion: new Promise(() => {}), release: () => {}, child: {} };
  });
  return { project, client };
}
it("warm native app uses one final admission and never compiles a selected artifact", async () => {
  const f = fixture();
  mkdirSync(f.client.root, { recursive: true, mode: 0o700 });
  writeFileSync(join(f.client.root, "build.json"), "selected");
  const app = await launchDevelopmentContainerApp(f.project);
  expect(mocks.read).toHaveBeenCalledWith(f.client, {});
  expect(mocks.build).not.toHaveBeenCalled();
  expect(mocks.ready).toHaveBeenCalledTimes(1);
  expect(app.nativeClient.id).toBe(f.client.id);
});
it("first native app preflights, builds the distinct host tuple with explicit Bun, then revalidates", async () => {
  const f = fixture();
  await launchDevelopmentContainerApp(f.project, { bun: "/pinned/bun" });
  expect(mocks.build).toHaveBeenCalledWith(f.client, {
    bun: "/pinned/bun",
    onlyIfSelectionAbsent: true,
    signal: undefined,
  });
  expect(mocks.ready).toHaveBeenCalledTimes(2);
  expect(mocks.launch).toHaveBeenCalledTimes(1);
});
it("invalid existing selection never invokes first-build fallback or launches", async () => {
  const f = fixture();
  mkdirSync(f.client.root, { recursive: true, mode: 0o700 });
  writeFileSync(join(f.client.root, "build.json"), "corrupt");
  mocks.read.mockImplementation(() => {
    throw Error("invalid manifest");
  });
  await expect(launchDevelopmentContainerApp(f.project, { bun: "/pinned/bun" })).rejects.toThrow(
    "invalid manifest",
  );
  expect(mocks.build).not.toHaveBeenCalled();
  expect(mocks.launch).not.toHaveBeenCalled();
});
it("missing first-build Bun returns actionable refusal, without compiling or creating an app", async () => {
  const f = fixture();
  await expect(launchDevelopmentContainerApp(f.project)).rejects.toMatchObject({
    reason: "build-failed",
  });
  expect(mocks.build).not.toHaveBeenCalled();
  expect(mocks.launch).not.toHaveBeenCalled();
});
