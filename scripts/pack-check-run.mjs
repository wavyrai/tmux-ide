import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
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

function findTarball(prefix) {
  const match = readdirSync(tarballDir).find(
    (file) => file.startsWith(prefix) && file.endsWith(".tgz"),
  );
  if (!match) throw new Error(`No tarball found for ${prefix}`);
  return join(tarballDir, match);
}

let child = null;
let childExit = null;
let cleanupError = null;
try {
  // The public root package contains the compiled root entrypoint and bundles
  // workspace-owned TypeScript. The private @tmux-ide/daemon workspace package
  // is not an installed runtime dependency of that CLI and must not mask an
  // incomplete root tarball in this smoke test.
  run("pnpm", ["build:cli"], { stdio: "inherit" });
  run("pnpm", ["pack", "--pack-destination", tarballDir], { stdio: "inherit" });

  const rootTarball = findTarball("tmux-ide-");
  run("npm", ["init", "-y"], { cwd: projectDir });
  run("npm", ["install", rootTarball], { cwd: projectDir, stdio: "inherit" });

  run("npx", ["tmux-ide", "--version"], { cwd: projectDir, stdio: "inherit" });

  const installedCli = join(projectDir, "node_modules", ".bin", "tmux-ide");
  child = spawn(installedCli, ["--headless", "--json"], {
    cwd: projectDir,
    env: { ...process.env, HOME: homeDir, npm_config_cache: join(tmpRoot, "npm-cache") },
    stdio: "ignore",
    detached: true,
  });
  childExit = new Promise((resolveExit) => child.once("exit", resolveExit));

  const daemonInfo = join(homeDir, ".tmux-ide", "daemon.json");
  const deadline = Date.now() + 10_000;
  while (!existsSync(daemonInfo) && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  }
  if (!existsSync(daemonInfo)) throw new Error("Headless daemon did not write daemon.json");

  const info = JSON.parse(readFileSync(daemonInfo, "utf-8"));
  if (info.pid !== child.pid) {
    throw new Error(`daemon.json PID ${info.pid} does not match direct child PID ${child.pid}`);
  }
  if (info.authToken !== null) {
    throw new Error("Headless loopback daemon unexpectedly inherited an auth token");
  }
  const health = await fetch(`http://127.0.0.1:${info.port}/health`);
  if (!health.ok) throw new Error(`Headless daemon health returned HTTP ${health.status}`);

  const contender = run(installedCli, ["--headless", "--json"], { cwd: projectDir });
  const contenderStatus = JSON.parse(contender.stdout.trim());
  if (contenderStatus.status !== "already-running" || contenderStatus.pid !== child.pid) {
    throw new Error(`Second headless start did not reuse owner: ${contender.stdout}`);
  }
} finally {
  if (child?.pid) {
    try {
      child.kill("SIGTERM");
    } catch {
      // Already exited.
    }
  }
  if (childExit) {
    const stopped = await Promise.race([
      childExit.then(() => true),
      new Promise((resolveDelay) => setTimeout(() => resolveDelay(false), 5_000)),
    ]);
    if (!stopped && child?.pid) {
      child.kill("SIGKILL");
      cleanupError = new Error("Installed headless daemon did not exit after SIGTERM");
    }
  }
  rmSync(tmpRoot, { recursive: true, force: true });
}

if (cleanupError) throw cleanupError;
