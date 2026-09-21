import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { prepareDevelopmentAppRemote, developmentRemoteAppLaunch } from "../lib/development-app.ts";
import {
  developmentContainerClient,
  developmentContainerClientInfo,
} from "../lib/development-container.ts";
import { resolveDevelopmentComposeProject } from "../lib/development-compose.ts";
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "native-remote-")));
  roots.push(root);
  const controlRoot = join(root, "private ' quoted path");
  mkdirSync(controlRoot, { mode: 0o700 });
  const config = "Host ti-dev-111111111111111111111111\n HostName 127.0.0.1\n User node\n";
  writeFileSync(join(controlRoot, "ssh_config"), config, { mode: 0o600 });
  return {
    root,
    remote: {
      alias: "ti-dev-111111111111111111111111",
      controlRoot,
      configHash: createHash("sha256").update(config).digest("hex"),
    },
  };
}
it("uses a separate canonical native tuple, never the Linux or ordinary native manifest", () => {
  const f = fixture();
  const tree = join(f.root, "tree");
  mkdirSync(tree);
  execFileSync("git", ["init", "-q", tree]);
  const p = resolveDevelopmentComposeProject({
    worktree: tree,
    name: "fixture",
    store: join(f.root, "store"),
  });
  const host = developmentContainerClient(p);
  expect(host.id).not.toBe(p.instance.id);
  expect(host.store).toBe(join(p.instance.store, "container-clients", p.instance.id));
  expect(developmentContainerClientInfo(p).cleanup.down).toEqual([
    "down",
    "--id",
    host.id,
    "--store",
    host.store,
  ]);
});
it("quotes a literal private config path and changes only child SSH args/PATH", () => {
  const f = fixture();
  const remote = prepareDevelopmentAppRemote(f.remote);
  const launch = {
    bin: "/immutable/tui",
    args: ["app"],
    env: { PATH: "/pinned/node/bin:/usr/bin", TMUX_IDE_DEVELOPMENT_BUILD: "pinned-generation" },
  };
  const actual = developmentRemoteAppLaunch(launch, remote);
  expect(actual.args).toEqual(["app", `--ssh=${remote.alias}`]);
  expect(actual.env.PATH).toBe(remote.directory + ":" + launch.env.PATH);
  expect(actual.env.TMUX_IDE_DEVELOPMENT_BUILD).toBe("pinned-generation");
  expect(launch.args).toEqual(["app"]);
  expect(developmentRemoteAppLaunch(launch)).toBe(launch);
  const output = execFileSync(join(remote.directory, "ssh"), ["-G", remote.alias], {
    encoding: "utf8",
    timeout: 3000,
    maxBuffer: 65536,
    stdio: ["ignore", "pipe", "ignore"],
  });
  expect(output).toContain("hostname 127.0.0.1");
});
it.each(["%d", ":", String.fromCharCode(10), "\\", '"'])(
  "rejects unrepresentable path character %j before wrapper creation",
  (bad) => {
    const f = fixture();
    expect(() =>
      prepareDevelopmentAppRemote({ ...f.remote, controlRoot: join(f.root, "unsafe" + bad) }),
    ).toThrow("representable");
  },
);
it("rejects redirected/private-wrapper or config changes instead of repairing them", () => {
  const f = fixture();
  const remote = prepareDevelopmentAppRemote(f.remote);
  writeFileSync(join(remote.directory, "ssh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  expect(() => prepareDevelopmentAppRemote(f.remote)).toThrow("changed");
  expect(() => developmentRemoteAppLaunch({ args: ["app"], env: {} }, remote)).toThrow();
  const g = fixture();
  symlinkSync(g.root, join(g.remote.controlRoot, "native-ssh"));
  expect(() => prepareDevelopmentAppRemote(g.remote)).toThrow();
  const h = fixture();
  const target = prepareDevelopmentAppRemote(h.remote);
  writeFileSync(join(h.remote.controlRoot, "ssh_config"), "ProxyCommand bad\n", { mode: 0o600 });
  expect(() => developmentRemoteAppLaunch({ args: ["app"], env: {} }, target)).toThrow();
});

it("rejects noncanonical roots and unexpected PATH executables", () => {
  const f = fixture();
  for (const root of ["relative", f.remote.controlRoot + "/../elsewhere"]) {
    expect(() => prepareDevelopmentAppRemote({ ...f.remote, controlRoot: root })).toThrow();
  }
  const remote = prepareDevelopmentAppRemote(f.remote);
  writeFileSync(join(remote.directory, "node"), "unexpected executable", { mode: 0o700 });
  expect(() =>
    developmentRemoteAppLaunch({ args: ["app"], env: { PATH: "/pinned" } }, remote),
  ).toThrow("unexpected entries");
});
