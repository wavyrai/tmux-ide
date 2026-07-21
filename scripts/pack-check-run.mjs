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

const children = [];
const childOutput = new Map();
const childExits = new Map();
let cleanupError = null;

function spawnInstalledCli(installedCli) {
  const child = spawn(installedCli, ["--headless", "--json"], {
    cwd: projectDir,
    env: { ...process.env, HOME: homeDir, npm_config_cache: join(tmpRoot, "npm-cache") },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const output = { stdout: "", stderr: "" };
  child.stdout?.on("data", (chunk) => {
    output.stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    output.stderr += chunk.toString();
  });
  childOutput.set(child, output);
  childExits.set(
    child,
    new Promise((resolveExit, rejectExit) => {
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
      child.once("error", rejectExit);
    }),
  );
  children.push(child);
  return child;
}

async function waitForChild(child, timeoutMs = 20_000) {
  const exit = await Promise.race([
    childExits.get(child),
    new Promise((_, rejectTimeout) =>
      setTimeout(() => rejectTimeout(new Error(`PID ${child.pid} did not exit`)), timeoutMs),
    ),
  ]);
  return { ...exit, ...childOutput.get(child) };
}

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
  const contenders = Array.from({ length: 12 }, () => spawnInstalledCli(installedCli));

  const daemonInfo = join(homeDir, ".tmux-ide", "daemon.json");
  const deadline = Date.now() + 10_000;
  while (!existsSync(daemonInfo) && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  }
  if (!existsSync(daemonInfo)) throw new Error("Headless daemon did not write daemon.json");

  const info = JSON.parse(readFileSync(daemonInfo, "utf-8"));
  const owner = contenders.find((candidate) => candidate.pid === info.pid);
  if (!owner) {
    throw new Error(`daemon.json PID ${info.pid} is not one of the installed CLI contenders`);
  }
  if (info.authToken !== null) {
    throw new Error("Headless loopback daemon unexpectedly inherited an auth token");
  }
  if (!Number.isInteger(info.protocolVersion) || info.protocolVersion < 1) {
    throw new Error(`daemon.json has invalid protocolVersion: ${info.protocolVersion}`);
  }
  if (typeof info.productVersion !== "string" || info.productVersion.length === 0) {
    throw new Error(`daemon.json has invalid productVersion: ${info.productVersion}`);
  }
  if (typeof info.instanceId !== "string" || info.instanceId.length === 0) {
    throw new Error("daemon.json has no instance identity");
  }
  const health = await fetch(`http://127.0.0.1:${info.port}/health`);
  if (!health.ok) throw new Error(`Headless daemon health returned HTTP ${health.status}`);
  const healthBody = await health.json();
  if (healthBody.protocolVersion !== info.protocolVersion) {
    throw new Error(
      `daemon.json protocol ${info.protocolVersion} disagrees with health ${healthBody.protocolVersion}`,
    );
  }
  if (healthBody.productVersion !== info.productVersion) {
    throw new Error(
      `daemon.json product ${info.productVersion} disagrees with health ${healthBody.productVersion}`,
    );
  }
  const healthz = await fetch(`http://127.0.0.1:${info.port}/healthz`);
  if (!healthz.ok) throw new Error(`Headless daemon healthz returned HTTP ${healthz.status}`);
  const healthzBody = await healthz.json();
  if (healthzBody.productVersion !== info.productVersion) {
    throw new Error(
      `daemon.json product ${info.productVersion} disagrees with healthz ${healthzBody.productVersion}`,
    );
  }
  const identity = await fetch(`http://127.0.0.1:${info.port}/identity`);
  if (!identity.ok) throw new Error(`Headless daemon identity returned HTTP ${identity.status}`);
  const identityBody = await identity.json();
  for (const key of ["pid", "protocolVersion", "productVersion", "instanceId", "startedAt"]) {
    if (identityBody[key] !== info[key]) {
      throw new Error(
        `daemon.json ${key} ${JSON.stringify(info[key])} disagrees with identity ${JSON.stringify(identityBody[key])}`,
      );
    }
  }

  const losers = contenders.filter((candidate) => candidate !== owner);
  const loserResults = await Promise.all(losers.map((candidate) => waitForChild(candidate)));
  for (const result of loserResults) {
    if (result.code !== 0) {
      throw new Error(
        `Installed contender failed (${result.code ?? result.signal}):\n${result.stdout}\n${result.stderr}`,
      );
    }
    const contenderStatus = JSON.parse(result.stdout.trim());
    if (
      contenderStatus.status !== "already-running" ||
      contenderStatus.pid !== owner.pid ||
      contenderStatus.port !== info.port
    ) {
      throw new Error(`Installed contender did not reuse owner: ${result.stdout}`);
    }
  }

  const liveChildren = contenders.filter(
    (candidate) => candidate.exitCode === null && candidate.signalCode === null,
  );
  if (liveChildren.length !== 1 || liveChildren[0] !== owner) {
    throw new Error(
      `Expected exactly owner PID ${owner.pid} alive; found ${liveChildren.map((child) => child.pid).join(", ")}`,
    );
  }
} finally {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      child.kill("SIGTERM");
    } catch {
      // Already exited.
    }
  }

  const liveChildren = children.filter(
    (child) => child.exitCode === null && child.signalCode === null,
  );
  if (liveChildren.length > 0) {
    const stopped = await Promise.race([
      Promise.all(liveChildren.map((child) => childExits.get(child))).then(() => true),
      new Promise((resolveDelay) => setTimeout(() => resolveDelay(false), 5_000)),
    ]);
    if (!stopped) {
      for (const child of liveChildren) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
      cleanupError = new Error("Installed headless contender did not exit after SIGTERM");
    }
  }
  rmSync(tmpRoot, { recursive: true, force: true });
}

if (cleanupError) throw cleanupError;
