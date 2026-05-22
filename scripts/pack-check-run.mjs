import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const tmpRoot = mkdtempSync(join(tmpdir(), "tmux-ide-pack-run-"));
const tarballDir = join(tmpRoot, "tarballs");
const projectDir = join(tmpRoot, "project");
const homeDir = join(tmpRoot, "home");
mkdirSync(tarballDir, { recursive: true });
mkdirSync(projectDir, { recursive: true });
mkdirSync(homeDir, { recursive: true });

function run(command, args, opts = {}) {
  const res = spawnSync(command, args, {
    cwd: opts.cwd ?? root,
    env: { ...process.env, HOME: homeDir, npm_config_cache: join(tmpRoot, "npm-cache") },
    encoding: "utf-8",
    stdio: opts.stdio ?? "pipe",
  });
  if (res.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed\n${res.stdout ?? ""}\n${res.stderr ?? ""}`,
    );
  }
  return res;
}

function findTarball(prefix, excludePrefix = null) {
  const match = readdirSync(tarballDir).find(
    (file) =>
      file.startsWith(prefix) &&
      (!excludePrefix || !file.startsWith(excludePrefix)) &&
      file.endsWith(".tgz"),
  );
  if (!match) throw new Error(`No tarball found for ${prefix}`);
  return join(tarballDir, match);
}

let child = null;
try {
  run("pnpm", ["--dir", "packages/daemon", "pack", "--pack-destination", tarballDir], {
    stdio: "inherit",
  });
  run("pnpm", ["pack", "--pack-destination", tarballDir], { stdio: "inherit" });

  const daemonTarball = findTarball("tmux-ide-daemon-");
  const rootTarball = findTarball("tmux-ide-", "tmux-ide-daemon-");
  run("npm", ["init", "-y"], { cwd: projectDir });
  run("npm", ["install", daemonTarball, rootTarball], { cwd: projectDir, stdio: "inherit" });

  run("npx", ["tmux-ide", "--version"], { cwd: projectDir, stdio: "inherit" });

  child = spawn("npx", ["tmux-ide", "--headless"], {
    cwd: projectDir,
    env: { ...process.env, HOME: homeDir, npm_config_cache: join(tmpRoot, "npm-cache") },
    stdio: "ignore",
    detached: true,
  });

  const daemonInfo = join(homeDir, ".tmux-ide", "daemon.json");
  const deadline = Date.now() + 10_000;
  while (!existsSync(daemonInfo) && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  }
  if (!existsSync(daemonInfo)) throw new Error("Headless daemon did not write daemon.json");

  run("npx", ["tmux-ide", "task", "list"], { cwd: projectDir, stdio: "inherit" });
} finally {
  if (child?.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {
        // Already exited.
      }
    }
  }
  rmSync(tmpRoot, { recursive: true, force: true });
}
