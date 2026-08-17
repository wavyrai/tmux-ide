import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = process.cwd();
const tmpRoot = mkdtempSync(join(tmpdir(), "tmux-ide-pack-run-"));
const tarballDir = join(tmpRoot, "tarballs");
const projectDir = join(tmpRoot, "project");
const launchDir = join(tmpRoot, "configless-cwd");
const homeDir = join(tmpRoot, "home");
// tmux's AF_UNIX path ceiling is only ~104 bytes on macOS. tmpdir() expands to
// a long /var/folders path there, so keep this one disposable socket root under
// the deliberately short /tmp spelling.
const tmuxTmpDir = mkdtempSync("/tmp/tip-");
const installedTmuxSocketPath = join(tmuxTmpDir, "pack.sock");
const installedTargetSession = "ordinary-isolated";
mkdirSync(tarballDir, { recursive: true });
mkdirSync(projectDir, { recursive: true });
mkdirSync(homeDir, { recursive: true });
mkdirSync(launchDir, { recursive: true });
chmodSync(tmuxTmpDir, 0o700);

function run(command, args, opts = {}) {
  const res = spawnSync(command, args, {
    cwd: opts.cwd ?? root,
    env: {
      ...process.env,
      HOME: homeDir,
      npm_config_cache: join(tmpRoot, "npm-cache"),
      ...opts.env,
    },
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

function shQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function tmuxEnv(runtimePath) {
  const tmuxPath = run("sh", ["-c", "command -v tmux"]).stdout.trim();
  return {
    HOME: homeDir,
    TMUX_TMPDIR: tmuxTmpDir,
    // The contributor shell may itself be inside tmux. Never let that ambient
    // socket override this gate's isolated TMUX_TMPDIR/default server.
    TMUX: "",
    TMUX_IDE_TMUX_SOCKET_PATH: installedTmuxSocketPath,
    TMUX_IDE_HOME: join(homeDir, ".tmux-ide"),
    NODE_PATH: "",
    BUN_INSTALL: "",
    // Do not let the installed smoke accidentally resolve tools from this
    // checkout's node_modules/.bin. The compiled TUI needs neither Bun nor the
    // repository after it has been built.
    PATH: [runtimePath, dirname(process.execPath), dirname(tmuxPath), "/usr/bin", "/bin"]
      .filter((value, index, values) => value && values.indexOf(value) === index)
      .join(":"),
  };
}

async function waitUntil(predicate, timeoutMs, description, diagnostics) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  const detail = (() => {
    try {
      return diagnostics?.() ?? "";
    } catch (error) {
      return `diagnostics failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  })();
  throw new Error(`Timed out waiting for ${description}${detail ? `\n${detail}` : ""}`);
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
    // The elected daemon and the later installed TUI must observe the same
    // isolated tmux server. Otherwise the daemon can be healthy while its
    // workspace catalog is reading the developer's default tmux socket.
    env: {
      ...process.env,
      ...tmuxEnv(dirname(installedCli)),
      npm_config_cache: join(tmpRoot, "npm-cache"),
    },
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

async function runInstalledTuiGate(installedCli) {
  const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const platformTag = `${process.platform}-${process.arch}`;
  if (!new Set(["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"]).has(platformTag)) {
    throw new Error(`Installed TUI gate has no release binary for ${platformTag}`);
  }

  // Model the real release/download layout rather than smuggling a checkout
  // path through TMUX_IDE_TUI_BIN. The installed CLI must discover this exact
  // versioned binary from its clean HOME by itself.
  const downloadedTui = join(
    homeDir,
    ".tmux-ide",
    "bin",
    `tmux-ide-tui-${platformTag}-${packageVersion}`,
  );
  run("bun", ["scripts/build-tui.mjs", "--outfile", downloadedTui], { stdio: "inherit" });

  const treeSitterSmoke = spawnSync(downloadedTui, ["__tree-sitter-smoke"], {
    cwd: launchDir,
    env: { ...process.env, ...tmuxEnv(dirname(installedCli)) },
    encoding: "utf8",
  });
  if (
    treeSitterSmoke.status !== 0 ||
    treeSitterSmoke.stdout.trim() !== "tree-sitter-worker-ready"
  ) {
    throw new Error(
      `Installed TUI Tree-sitter worker smoke failed (${treeSitterSmoke.status}):\n` +
        `${treeSitterSmoke.stdout}${treeSitterSmoke.stderr}`,
    );
  }

  const targetSession = installedTargetSession;
  const hostSession = "installed-tui-gate";
  const statusPath = join(tmpRoot, "installed-tui.status");
  const readyPath = join(tmpRoot, "installed-tui.ready.json");
  const performancePath = join(tmpRoot, "installed-tui.performance.jsonl");
  const stderrPath = join(tmpRoot, "installed-tui.stderr");
  const launcherPath = join(tmpRoot, "launch-installed-tui.sh");
  const inputMarker = `M59_PACKED_INPUT_${process.pid}`;
  const runtimeEnv = tmuxEnv(dirname(installedCli));
  const tmuxArgs = (...args) => ["-S", installedTmuxSocketPath, ...args];
  const tmuxResult = (args, stdio = "pipe") =>
    spawnSync("tmux", tmuxArgs(...args), {
      cwd: launchDir,
      env: { ...process.env, ...runtimeEnv },
      encoding: "utf8",
      stdio,
    });
  const gateDiagnostics = () => {
    const frame = tmuxResult(["capture-pane", "-p", "-t", `=${hostSession}:0.0`]);
    const pane = tmuxResult([
      "list-panes",
      "-t",
      `=${hostSession}`,
      "-F",
      "pid=#{pane_pid} dead=#{pane_dead} status=#{pane_dead_status} command=#{pane_current_command}",
    ]);
    const readiness = existsSync(readyPath) ? readFileSync(readyPath, "utf8").trim() : "missing";
    const performance = existsSync(performancePath)
      ? readFileSync(performancePath, "utf8").trim().split("\n").slice(-20).join("\n")
      : "missing";
    const stderr = existsSync(stderrPath) ? readFileSync(stderrPath, "utf8").trim() : "";
    return [
      `readiness: ${readiness}`,
      `performance tail:\n${performance}`,
      `pane: ${pane.status === 0 ? pane.stdout.trim() : pane.stderr.trim()}`,
      `frame:\n${frame.status === 0 ? frame.stdout : frame.stderr}`,
      `stderr:\n${stderr || "(empty)"}`,
    ].join("\n");
  };
  const processIdentity = (pid) => {
    const observed = spawnSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const identity = observed.status === 0 ? observed.stdout.trim() : "";
    return identity && identity.includes(downloadedTui) ? identity : null;
  };
  const terminateLaunchedTui = async () => {
    if (!existsSync(readyPath)) return;
    let readiness;
    try {
      readiness = JSON.parse(readFileSync(readyPath, "utf8"));
    } catch {
      return;
    }
    if (
      readiness?.version !== 1 ||
      readiness.phase !== "input-ready" ||
      readiness.surface !== "app"
    )
      return;
    const pid = readiness.pid;
    if (!Number.isSafeInteger(pid) || pid <= 1) return;
    const identity = processIdentity(pid);
    if (!identity) return;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      const currentIdentity = processIdentity(pid);
      if (!currentIdentity || currentIdentity !== identity) return;
    }
    if (processIdentity(pid) !== identity) return;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The exact hosted TUI exited between the final probe and escalation.
    }
  };

  for (const forbidden of ["bunfig.toml", "node_modules", join(".tmux-ide", "workspace.yml")]) {
    if (existsSync(join(launchDir, forbidden))) {
      throw new Error(`Installed TUI gate cwd unexpectedly contains ${forbidden}`);
    }
  }
  const leakedHostBinary = join(
    projectDir,
    "node_modules",
    "tmux-ide",
    "packages",
    "daemon",
    "dist",
    "tui",
    "tmux-ide-tui",
  );
  if (existsSync(leakedHostBinary)) {
    throw new Error("Universal npm tarball leaked a host-only compiled TUI binary");
  }

  writeFileSync(
    launcherPath,
    [
      "#!/bin/sh",
      `export TMUX_IDE_TUI_READY_FILE=${shQuote(readyPath)}`,
      `export TMUX_IDE_TUI_PERF_LOG=${shQuote(performancePath)}`,
      `${shQuote(installedCli)} app ${shQuote(targetSession)} 2>${shQuote(stderrPath)}`,
      "status=$?",
      `printf '%s\\n' "$status" > ${shQuote(statusPath)}`,
      'exit "$status"',
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  chmodSync(launcherPath, 0o700);

  let captured = "";
  try {
    const host = tmuxResult([
      "new-session",
      "-d",
      "-s",
      hostSession,
      "-x",
      "120",
      "-y",
      "36",
      "-c",
      launchDir,
      launcherPath,
    ]);
    if (host.status !== 0) throw new Error(`Could not launch installed TUI: ${host.stderr}`);

    await waitUntil(
      () => {
        if (existsSync(statusPath)) {
          const earlyStatus = readFileSync(statusPath, "utf8").trim();
          throw new Error(
            `Installed configless TUI exited ${earlyStatus} before terminal readiness`,
          );
        }
        const frame = tmuxResult(["capture-pane", "-p", "-t", `=${hostSession}:0.0`]);
        if (frame.status === 0) captured = frame.stdout;
        return existsSync(readyPath) && captured.includes("tmux-ide");
      },
      20_000,
      "the installed TUI's input-ready barrier",
      gateDiagnostics,
    );

    // Once the host is ready, every remaining milestone is mandatory. An early
    // clean exit above is a failure, never a shortcut around these assertions.
    {
      const readiness = JSON.parse(readFileSync(readyPath, "utf8"));
      if (
        readiness.version !== 1 ||
        readiness.phase !== "input-ready" ||
        readiness.surface !== "app"
      ) {
        throw new Error(`Installed TUI published invalid readiness: ${JSON.stringify(readiness)}`);
      }

      await waitUntil(
        () => {
          if (!existsSync(performancePath)) return false;
          return readFileSync(performancePath, "utf8")
            .split("\n")
            .some((line) => {
              if (!line) return false;
              try {
                return JSON.parse(line).phase === "first-terminal-frame";
              } catch {
                return false;
              }
            });
        },
        20_000,
        "the installed TUI's first coherent terminal frame",
        gateDiagnostics,
      );

      const input = tmuxResult([
        "send-keys",
        "-l",
        "-t",
        `=${hostSession}:0.0`,
        `printf '${inputMarker}\\n'`,
      ]);
      if (input.status !== 0) throw new Error(`Could not type into installed TUI: ${input.stderr}`);
      const enter = tmuxResult(["send-keys", "-t", `=${hostSession}:0.0`, "Enter"]);
      if (enter.status !== 0)
        throw new Error(`Could not submit installed TUI input: ${enter.stderr}`);

      await waitUntil(
        () => {
          const native = tmuxResult(["capture-pane", "-p", "-t", `=${targetSession}:0.0`]);
          const hostFrame = tmuxResult(["capture-pane", "-p", "-t", `=${hostSession}:0.0`]);
          if (hostFrame.status === 0) captured = hostFrame.stdout;
          return (
            native.status === 0 &&
            native.stdout.includes(inputMarker) &&
            hostFrame.status === 0 &&
            hostFrame.stdout.includes(inputMarker)
          );
        },
        10_000,
        "the installed TUI input to reach both the canonical frame and native pane",
        gateDiagnostics,
      );

      for (const option of ["@tmux_ide_adopted", "@tmux_ide_workspace_promoted_v1"]) {
        const observed = tmuxResult(["show-options", "-v", "-t", targetSession, option]);
        if (observed.status !== 0 || observed.stdout.trim() !== "1") {
          throw new Error(
            `Installed configless TUI did not publish ${option}=1: ${observed.stderr || observed.stdout}`,
          );
        }
      }
      const quit = tmuxResult(["send-keys", "-t", `=${hostSession}:0.0`, "C-q"]);
      if (quit.status !== 0) throw new Error(`Could not ask installed TUI to exit: ${quit.stderr}`);
    }
    await waitUntil(
      () => existsSync(statusPath),
      10_000,
      "the installed TUI's clean exit",
      gateDiagnostics,
    );

    const status = readFileSync(statusPath, "utf8").trim();
    const stderr = existsSync(stderrPath) ? readFileSync(stderrPath, "utf8") : "";
    const transcript = `${captured}\n${stderr}`;
    if (status !== "0") {
      throw new Error(`Installed configless TUI exited ${status}:\n${transcript}`);
    }
    if (/preload not found|@opentui\/solid\/preload/iu.test(transcript)) {
      throw new Error(`Installed configless TUI attempted a checkout preload:\n${transcript}`);
    }
  } finally {
    await terminateLaunchedTui();
    tmuxResult(["kill-server"]);
  }
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
  const target = spawnSync(
    "tmux",
    [
      "-S",
      installedTmuxSocketPath,
      "new-session",
      "-d",
      "-s",
      installedTargetSession,
      "-x",
      "100",
      "-y",
      "30",
      "-c",
      launchDir,
    ],
    {
      cwd: launchDir,
      env: { ...process.env, ...tmuxEnv(dirname(installedCli)) },
      encoding: "utf8",
    },
  );
  if (target.status !== 0) {
    throw new Error(`Could not create isolated target session: ${target.stderr}`);
  }
  const installedBundle = readFileSync(
    join(projectDir, "node_modules", "tmux-ide", "bin", "cli.js"),
    "utf8",
  );
  for (const removed of [
    "TerminalInputAuthority",
    "terminal/input-authority",
    "SessionRuntimeClientCapability",
    "SessionRuntimeSourcePaneBinding",
    "executeAuthorized",
    "The daemon has reached its bounded multiplexer operation capacity.",
    "tmux-ide-internal-read-v1",
    "withTrustedOrigin",
  ]) {
    if (installedBundle.includes(removed)) {
      throw new Error(`Installed CLI still contains removed authority architecture: ${removed}`);
    }
  }
  for (const required of [
    "PaneSourceCredentialAuthority",
    "X-Tmux-Ide-Pane-Source-Credential",
    "X-Tmux-Ide-Host-Client-Id",
    "submitPaneCredentialIntent",
    "SessionSemanticMutationExecutor",
    "registerInternalReadOperation",
    "Semantic mutation requires a live host, pane, or owner principal",
  ]) {
    if (!installedBundle.includes(required)) {
      throw new Error(
        `Installed CLI is missing authenticated provenance architecture: ${required}`,
      );
    }
  }
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
  if (typeof info.authToken !== "string" || info.authToken.length < 32) {
    throw new Error("Headless loopback daemon did not publish a strong owner auth token");
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

  // Exercise the installed configless app only after the cold-start election.
  // The app is now a thin client which intentionally ensures and reuses the
  // persistent canonical daemon; running it before this section would make the
  // election warm and leave an untracked detached owner outside `children`.
  await runInstalledTuiGate(installedCli);
} finally {
  spawnSync("tmux", ["-S", installedTmuxSocketPath, "kill-server"], {
    env: { ...process.env, TMUX: "" },
    stdio: "ignore",
  });
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
  rmSync(tmuxTmpDir, { recursive: true, force: true });
}

if (cleanupError) throw cleanupError;
