import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { gzipSync } from "node:zlib";
import { frameShowsTerminalFocus } from "./lib/packed-opentui-frame.mjs";

const root = process.cwd();
const tmpRoot = mkdtempSync(join(tmpdir(), "tmux-ide-pack-run-"));
const tarballDir = join(tmpRoot, "tarballs");
const projectDir = join(tmpRoot, "project");
const launchDir = join(tmpRoot, "configless-cwd");
const homeDir = join(tmpRoot, "home");
const mockReleaseDir = join(tmpRoot, "mock-release");
const mockReleaseBinaryPath = join(mockReleaseDir, "tmux-ide-tui");
const mockReleaseAssetPath = join(mockReleaseDir, "tmux-ide-tui.gz");
const mockReleaseManifestPath = join(mockReleaseDir, "tmux-ide-tui.gz.sha256");
const mockFetchPreloadPath = join(tmpRoot, "mock-release-fetch.mjs");
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
mkdirSync(mockReleaseDir, { recursive: true });
chmodSync(tmuxTmpDir, 0o700);
writeFileSync(
  mockFetchPreloadPath,
  `import { readFileSync } from "node:fs";

const nativeFetch = globalThis.fetch;
globalThis.fetch = async (resource, init) => {
  const url = typeof resource === "string" ? resource : resource instanceof URL ? resource.href : resource.url;
  if (!url.includes("/releases/download/")) {
    return nativeFetch(resource, init);
  }
  const mode = process.env.TMUX_IDE_PACK_FETCH_MODE ?? "success";
  if (mode === "offline") throw new TypeError("mock release channel offline");
  if (mode === "timeout") throw new Error("mock release channel timed out");
  if (mode === "http-error") {
    return new Response("unavailable", { status: 503, statusText: "Mock Unavailable" });
  }
  if (mode !== "success") throw new Error(\`unknown mock release channel mode: \${mode}\`);
  if (url.endsWith(".sha256")) {
    return new Response(readFileSync(process.env.TMUX_IDE_PACK_TUI_MANIFEST), { status: 200 });
  }
  if (!url.endsWith(".gz")) throw new Error(\`unexpected mock release asset: \${url}\`);
  return new Response(readFileSync(process.env.TMUX_IDE_PACK_TUI_ASSET), {
    status: 200,
    headers: { "content-type": "application/gzip" },
  });
};
`,
  { mode: 0o600 },
);

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

function tmuxEnv(runtimePath, fetchMode = "success") {
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
    NODE_OPTIONS: `--import=${mockFetchPreloadPath}`,
    TMUX_IDE_PACK_FETCH_MODE: fetchMode,
    TMUX_IDE_PACK_TUI_ASSET: mockReleaseAssetPath,
    TMUX_IDE_PACK_TUI_MANIFEST: mockReleaseManifestPath,
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
    if (await predicate()) return;
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

  // Build a real compiled dispatcher, but expose it only as a gzipped mock
  // release asset. The installed CLI starts with an empty state HOME and must
  // exercise its automatic fetch, inflate, verify, chmod, and exact-version
  // discovery path rather than receiving TMUX_IDE_TUI_BIN or a pre-seeded file.
  const downloadedTui = join(
    homeDir,
    ".tmux-ide",
    "bin",
    `tmux-ide-tui-${platformTag}-${packageVersion}`,
  );
  run("bun", ["scripts/build-tui.mjs", "--outfile", mockReleaseBinaryPath], {
    stdio: "inherit",
  });
  const mockBinary = readFileSync(mockReleaseBinaryPath);
  const mockAsset = gzipSync(mockBinary);
  writeFileSync(mockReleaseAssetPath, mockAsset);
  const assetName = `tmux-ide-tui-${platformTag}.gz`;
  writeFileSync(
    mockReleaseManifestPath,
    [
      `${createHash("sha256").update(mockAsset).digest("hex")}  ${assetName}`,
      `${createHash("sha256").update(mockBinary).digest("hex")}  ${assetName.slice(0, -3)}`,
      `version ${packageVersion}`,
      `platform ${platformTag}`,
      `commit ${"0".repeat(40)}`,
      "",
    ].join("\n"),
  );
  if (existsSync(downloadedTui)) {
    throw new Error("Installed TUI gate was not a clean automatic-acquisition first run");
  }

  const treeSitterSmoke = spawnSync(mockReleaseBinaryPath, ["__tree-sitter-smoke"], {
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
            `Installed configless TUI exited ${earlyStatus} before terminal readiness\n${gateDiagnostics()}`,
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
    if (!existsSync(downloadedTui)) {
      throw new Error("Installed configless TUI did not persist its automatic release runtime");
    }
    if (
      !/downloading checksum manifest https:\/\/github\.com\/.+tmux-ide-tui-.+\.gz\.sha256/iu.test(
        stderr,
      ) ||
      !/installed .+tmux-ide-tui-.+\([^)]+commit [a-f0-9]{12}\)/iu.test(stderr)
    ) {
      throw new Error(
        `Installed configless TUI did not report verified automatic acquisition:\n${stderr}`,
      );
    }
  } finally {
    await terminateLaunchedTui();
    tmuxResult(["kill-server"]);
  }
}

async function runPackedGoldenJourney(installedCli, initialOwner) {
  const runtimeEnv = tmuxEnv(dirname(installedCli));
  const tmuxArgs = (...args) => ["-S", installedTmuxSocketPath, ...args];
  const tmuxResult = (args, options = {}) =>
    spawnSync("tmux", tmuxArgs(...args), {
      cwd: launchDir,
      env: { ...process.env, ...runtimeEnv },
      encoding: "utf8",
      ...options,
    });
  const observations = [];
  const observe = async (name, timeoutMs, operation, diagnostics) => {
    const startedAt = performance.now();
    await waitUntil(operation, timeoutMs, name, diagnostics);
    observations.push({ name, elapsedMs: Math.round(performance.now() - startedAt), timeoutMs });
  };
  const sessionNames = () => {
    const result = tmuxResult(["list-sessions", "-F", "#{session_name}"]);
    return result.status === 0 ? result.stdout.trim().split("\n").filter(Boolean) : [];
  };
  const daemonSessionNames = async () => {
    const infoPath = join(homeDir, ".tmux-ide", "daemon.json");
    if (!existsSync(infoPath)) return [];
    const info = JSON.parse(readFileSync(infoPath, "utf8"));
    try {
      const response = await fetch(
        `http://127.0.0.1:${info.port}/api/resources/workspace-catalog?version=2`,
      );
      if (!response.ok) return [];
      const catalog = await response.json();
      return Array.isArray(catalog.liveSessions)
        ? catalog.liveSessions.map(({ sessionName }) => sessionName).filter(Boolean)
        : [];
    } catch {
      return [];
    }
  };
  const paneCount = (session) => {
    const result = tmuxResult(["list-panes", "-t", `=${session}`, "-F", "#{pane_id}"]);
    return result.status === 0 ? result.stdout.trim().split("\n").filter(Boolean).length : 0;
  };
  const windowCount = (session) => {
    const result = tmuxResult(["list-windows", "-t", `=${session}`, "-F", "#{window_id}"]);
    return result.status === 0 ? result.stdout.trim().split("\n").filter(Boolean).length : 0;
  };
  const activePane = (session) => {
    // `display-message` expects a pane target; the trailing colon selects the
    // active pane in the session's active window while preserving exact-name
    // session matching.
    const result = tmuxResult(["display-message", "-p", "-t", `=${session}:`, "#{pane_id}"]);
    return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
  };
  const paneWidth = (pane) => {
    const result = tmuxResult(["display-message", "-p", "-t", pane, "#{pane_width}"]);
    return result.status === 0 ? Number(result.stdout.trim()) : null;
  };
  const capture = (target) => {
    const result = tmuxResult(["capture-pane", "-p", "-t", target]);
    return result.status === 0 ? result.stdout : result.stderr;
  };
  let launchIndex = 0;
  const launchApp = async ({ target = null, hosted = false } = {}) => {
    launchIndex += 1;
    const hostSession = `_tmux-ide-pack-journey-${launchIndex}`;
    const stem = join(tmpRoot, `journey-${launchIndex}`);
    const statusPath = `${stem}.status`;
    const readyPath = `${stem}.ready.json`;
    const performancePath = `${stem}.performance.jsonl`;
    const stderrPath = `${stem}.stderr`;
    const launcherPath = `${stem}.sh`;
    const args = ["app", ...(target ? [target] : [])];
    writeFileSync(
      launcherPath,
      [
        "#!/bin/sh",
        `export TMUX_IDE_TUI_READY_FILE=${shQuote(readyPath)}`,
        `export TMUX_IDE_TUI_PERF_LOG=${shQuote(performancePath)}`,
        ...(hosted ? ["export TMUX_IDE_HOSTED=1"] : []),
        `${shQuote(installedCli)} ${args.map(shQuote).join(" ")} 2>${shQuote(stderrPath)}`,
        "status=$?",
        `printf '%s\\n' "$status" > ${shQuote(statusPath)}`,
        'exit "$status"',
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    const created = tmuxResult([
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
    if (created.status !== 0) throw new Error(`Could not launch ${hostSession}: ${created.stderr}`);
    const targetPane = `=${hostSession}:0.0`;
    const diagnostics = () =>
      [
        `sessions: ${sessionNames().join(", ") || "(none)"}`,
        `host: ${hostSession}`,
        `frame:\n${capture(targetPane)}`,
        `stderr:\n${existsSync(stderrPath) ? readFileSync(stderrPath, "utf8") : "(missing)"}`,
      ].join("\n");
    await observe(
      `${hosted ? "hosted " : ""}app ${target ?? "chooser"} input-ready`,
      20_000,
      () => {
        if (existsSync(statusPath))
          throw new Error(`Packed app exited before readiness\n${diagnostics()}`);
        return existsSync(readyPath) && capture(targetPane).includes("tmux-ide");
      },
      diagnostics,
    );
    return {
      hostSession,
      targetPane,
      statusPath,
      readyPath,
      performancePath,
      stderrPath,
      diagnostics,
    };
  };
  const send = (app, ...keys) => {
    const result = tmuxResult(["send-keys", "-t", app.targetPane, ...keys]);
    if (result.status !== 0) throw new Error(`Could not send ${keys.join(" ")}: ${result.stderr}`);
  };
  const typeCommand = (app, command) => {
    const literal = tmuxResult(["send-keys", "-l", "-t", app.targetPane, command]);
    if (literal.status !== 0) throw new Error(`Could not type packed input: ${literal.stderr}`);
    send(app, "Enter");
  };
  const cleanQuit = async (app) => {
    send(app, "C-q");
    await observe("clean quit", 10_000, () => existsSync(app.statusPath), app.diagnostics);
    const status = readFileSync(app.statusPath, "utf8").trim();
    if (status !== "0") throw new Error(`Packed app quit with ${status}\n${app.diagnostics()}`);
  };
  const createSession = (name) => {
    const result = tmuxResult([
      "new-session",
      "-d",
      "-s",
      name,
      "-x",
      "100",
      "-y",
      "30",
      "-c",
      launchDir,
    ]);
    if (result.status !== 0) throw new Error(`Could not create ${name}: ${result.stderr}`);
  };

  // The preceding first-run gate killed the isolated tmux server. Its host
  // sessions were deliberately `_tmux-ide-*`, so the catalog starts truly empty.
  const empty = await launchApp();
  await observe(
    "no-session chooser",
    10_000,
    () => capture(empty.targetPane).includes("no workspace authority"),
    empty.diagnostics,
  );
  await cleanQuit(empty);

  for (const name of ["journey-alpha", "journey-beta", "journey-gamma"]) createSession(name);
  // The first-run gate intentionally killed and recreated the isolated tmux
  // server. Restart the installed daemon so its tmux observer is bound to the
  // new server generation before asserting catalog-driven chooser behavior.
  initialOwner.kill("SIGTERM");
  await waitForChild(initialOwner);
  const catalogOwner = spawnInstalledCli(installedCli);
  await observe(
    "daemon binds recreated tmux server",
    20_000,
    () => {
      const infoPath = join(homeDir, ".tmux-ide", "daemon.json");
      if (!existsSync(infoPath)) return false;
      return JSON.parse(readFileSync(infoPath, "utf8")).pid === catalogOwner.pid;
    },
    () => `tmux sessions: ${sessionNames().join(", ")}`,
  );
  await observe(
    "daemon discovers many sessions",
    10_000,
    async () => {
      const discovered = await daemonSessionNames();
      return ["journey-alpha", "journey-beta", "journey-gamma"].every((name) =>
        discovered.includes(name),
      );
    },
    () => `tmux sessions: ${sessionNames().join(", ")}`,
  );
  const many = await launchApp();
  await observe(
    "many-session chooser",
    10_000,
    () =>
      ["journey-alpha", "journey-beta", "journey-gamma"].every((name) =>
        capture(many.targetPane).includes(name),
      ),
    many.diagnostics,
  );
  send(many, "Down", "Enter");
  const chooserMarker = `PACK_CHOOSER_${process.pid}`;
  await observe(
    "chooser opens selected session",
    10_000,
    () => capture(many.targetPane).includes("journey-beta"),
    many.diagnostics,
  );
  let stableTerminalFocusFrames = 0;
  await observe(
    "chooser terminal focus settles",
    5_000,
    () => {
      if (!frameShowsTerminalFocus(capture(many.targetPane))) {
        stableTerminalFocusFrames = 0;
        return false;
      }
      stableTerminalFocusFrames += 1;
      return stableTerminalFocusFrames >= 5;
    },
    many.diagnostics,
  );
  typeCommand(many, `printf '${chooserMarker}\\n'`);
  await observe(
    "chooser keyboard input",
    10_000,
    () => capture("=journey-beta:0.0").includes(chooserMarker),
    many.diagnostics,
  );
  await cleanQuit(many);

  for (const name of ["journey-alpha", "journey-gamma"])
    tmuxResult(["kill-session", "-t", `=${name}`]);
  await observe(
    "daemon discovers one session",
    10_000,
    async () => {
      const discovered = await daemonSessionNames();
      return discovered.length === 1 && discovered[0] === "journey-beta";
    },
    () => `tmux sessions: ${sessionNames().join(", ")}`,
  );
  const preparedWindow = tmuxResult([
    "new-window",
    "-d",
    "-n",
    "pack-window",
    "-t",
    "=journey-beta",
    "-c",
    launchDir,
  ]);
  if (preparedWindow.status !== 0)
    throw new Error(`Could not prepare second window: ${preparedWindow.stderr}`);
  const one = await launchApp();
  await observe(
    "one-session automatic open",
    10_000,
    () => capture(one.targetPane).includes("journey-beta"),
    one.diagnostics,
  );
  let stableOneSessionFocusFrames = 0;
  await observe(
    "one-session terminal focus settles",
    5_000,
    () => {
      if (!frameShowsTerminalFocus(capture(one.targetPane))) {
        stableOneSessionFocusFrames = 0;
        return false;
      }
      stableOneSessionFocusFrames += 1;
      return stableOneSessionFocusFrames >= 5;
    },
    one.diagnostics,
  );

  const keyboardMarker = `PACK_KEYBOARD_${process.pid}`;
  typeCommand(one, `printf '${keyboardMarker}\\n'`);
  await observe(
    "keyboard input",
    10_000,
    () => capture("=journey-beta:0.0").includes(keyboardMarker),
    one.diagnostics,
  );

  const pasteMarker = `PACK_PASTE_${process.pid}`;
  const setBuffer = tmuxResult([
    "set-buffer",
    "-b",
    "pack-journey-paste",
    `printf '${pasteMarker}\\n'`,
  ]);
  if (setBuffer.status !== 0) throw new Error(`Could not prepare paste: ${setBuffer.stderr}`);
  const paste = tmuxResult([
    "paste-buffer",
    "-p",
    "-b",
    "pack-journey-paste",
    "-t",
    one.targetPane,
  ]);
  if (paste.status !== 0) throw new Error(`Could not paste into packed TUI: ${paste.stderr}`);
  send(one, "Enter");
  await observe(
    "bracketed paste input",
    10_000,
    () => capture("=journey-beta:0.0").includes(pasteMarker),
    one.diagnostics,
  );

  send(one, "F5", "Down", "Enter");
  await observe("split pane right", 10_000, () => paneCount("journey-beta") === 2, one.diagnostics);
  let stableSplitFrames = 0;
  await observe(
    "split pane semantic publication settles",
    10_000,
    () => {
      const semanticPanes = capture(one.targetPane).match(/pane\.[a-z0-9.]+/giu) ?? [];
      if (new Set(semanticPanes).size < 2) {
        stableSplitFrames = 0;
        return false;
      }
      stableSplitFrames += 1;
      return stableSplitFrames >= 3;
    },
    one.diagnostics,
  );
  const beforeFocus = activePane("journey-beta");
  send(one, "C-o");
  await observe(
    "keyboard pane focus cycle",
    10_000,
    () => Boolean(activePane("journey-beta") && activePane("journey-beta") !== beforeFocus),
    one.diagnostics,
  );
  const focused = activePane("journey-beta");
  if (!focused) throw new Error(`No focused pane after Ctrl+O\n${one.diagnostics()}`);
  const focusMarker = `PACK_FOCUS_${process.pid}`;
  typeCommand(one, `printf '${focusMarker}\\n'`);
  await observe(
    "focused-pane input",
    10_000,
    () => capture(focused).includes(focusMarker),
    one.diagnostics,
  );

  const widthBefore = paneWidth(focused);
  send(one, "M-Right");
  await observe(
    "keyboard pane resize",
    10_000,
    () => widthBefore !== null && paneWidth(focused) !== widthBefore,
    one.diagnostics,
  );

  send(one, "C-t");
  await observe(
    "keyboard window switch",
    10_000,
    () => windowCount("journey-beta") === 2 && activePane("journey-beta") !== focused,
    one.diagnostics,
  );

  // Close is intentionally two activations: the first arms the destructive
  // palette row; only the second dispatches the daemon mutation.
  send(one, "F5", "Down", "Down", "Down", "Enter");
  await observe(
    "close confirmation armed",
    5_000,
    () => capture(one.targetPane).includes("Confirm close pane"),
    one.diagnostics,
  );
  send(one, "Enter");
  await observe(
    "confirmed pane close",
    10_000,
    () => windowCount("journey-beta") === 1,
    one.diagnostics,
  );

  const oldInstanceId = JSON.parse(
    readFileSync(join(homeDir, ".tmux-ide", "daemon.json"), "utf8"),
  ).instanceId;
  catalogOwner.kill("SIGTERM");
  await waitForChild(catalogOwner);
  const replacement = spawnInstalledCli(installedCli);
  await observe(
    "daemon replacement",
    20_000,
    () => {
      if (!existsSync(join(homeDir, ".tmux-ide", "daemon.json"))) return false;
      const next = JSON.parse(readFileSync(join(homeDir, ".tmux-ide", "daemon.json"), "utf8"));
      return next.instanceId !== oldInstanceId && next.pid === replacement.pid;
    },
    one.diagnostics,
  );
  let stableReconnectFocusFrames = 0;
  await observe(
    "TUI replacement generation focus settles",
    20_000,
    () => {
      const frame = capture(one.targetPane);
      if (!frame.includes(" live") || !frameShowsTerminalFocus(frame)) {
        stableReconnectFocusFrames = 0;
        return false;
      }
      stableReconnectFocusFrames += 1;
      return stableReconnectFocusFrames >= 5;
    },
    one.diagnostics,
  );
  const reconnectMarker = `PACK_RECONNECT_${process.pid}`;
  typeCommand(one, `printf '${reconnectMarker}\\n'`);
  await observe(
    "TUI daemon reconnect input",
    20_000,
    () => capture(focused).includes(reconnectMarker),
    one.diagnostics,
  );
  await cleanQuit(one);

  // Exercise hosted put-away with a real isolated tmux client. Control mode is
  // terminal-independent but still owns a genuine client/session stack.
  createSession("_tmux-ide-pack-return-seed");
  const hosted = await launchApp({ target: "journey-beta", hosted: true });
  const controlClient = spawn(
    "tmux",
    tmuxArgs("-C", "attach-session", "-t", "=_tmux-ide-pack-return-seed"),
    { env: { ...process.env, ...runtimeEnv }, stdio: ["pipe", "pipe", "pipe"] },
  );
  children.push(controlClient);
  childExits.set(
    controlClient,
    new Promise((resolveExit) =>
      controlClient.once("exit", (code, signal) => resolveExit({ code, signal })),
    ),
  );
  childOutput.set(controlClient, { stdout: "", stderr: "" });
  const controlClientTarget = () => {
    const clients = tmuxResult([
      "list-clients",
      "-F",
      "#{client_name}\t#{client_pid}\t#{session_name}",
    ]);
    if (clients.status !== 0) return null;
    const row = clients.stdout
      .trim()
      .split("\n")
      .map((line) => line.split("\t"))
      .find(([, , session]) => session === "_tmux-ide-pack-return-seed");
    return row?.[0] || null;
  };
  const switchTo = (session) => {
    const client = controlClientTarget();
    if (!client) throw new Error("Could not resolve the isolated control client name.");
    const result = tmuxResult(["switch-client", "-c", client, "-t", `=${session}`]);
    if (result.status !== 0) throw new Error(`Could not switch control client: ${result.stderr}`);
  };
  await observe(
    "hosted client attached",
    10_000,
    () => controlClientTarget() !== null,
    hosted.diagnostics,
  );
  switchTo(hosted.hostSession);
  send(hosted, "C-q");
  await observe(
    "hosted put-away preserves app",
    10_000,
    () => {
      const client = controlClientTarget();
      const clients = tmuxResult(["list-clients", "-F", "#{client_name}:#{session_name}"]);
      return (
        client !== null &&
        clients.status === 0 &&
        clients.stdout.includes(`${client}:_tmux-ide-pack-return-seed`) &&
        !existsSync(hosted.statusPath)
      );
    },
    hosted.diagnostics,
  );
  switchTo(hosted.hostSession);
  let stableReturnFocusFrames = 0;
  await observe(
    "hosted return focus settles",
    10_000,
    () => {
      const frame = capture(hosted.targetPane);
      const clients = tmuxResult(["list-clients", "-F", "#{session_name}"]);
      if (
        clients.status !== 0 ||
        !clients.stdout.split("\n").includes(hosted.hostSession) ||
        !frameShowsTerminalFocus(frame)
      ) {
        stableReturnFocusFrames = 0;
        return false;
      }
      stableReturnFocusFrames += 1;
      return stableReturnFocusFrames >= 5;
    },
    hosted.diagnostics,
  );
  const returnMarker = `PACK_RETURN_${process.pid}`;
  typeCommand(hosted, `printf '${returnMarker}\\n'`);
  await observe(
    "hosted return preserves workspace",
    10_000,
    () => capture(focused).includes(returnMarker),
    hosted.diagnostics,
  );
  tmuxResult(["kill-session", "-t", `=${hosted.hostSession}`]);
  controlClient.kill("SIGTERM");

  console.log(`packed OpenTUI journey latency ${JSON.stringify(observations)}`);
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
  const daemonInfo = join(homeDir, ".tmux-ide", "daemon.json");
  const installedCommand = (args, fetchMode = "success", timeout = 10_000) =>
    spawnSync(installedCli, args, {
      cwd: launchDir,
      env: {
        ...process.env,
        ...tmuxEnv(dirname(installedCli), fetchMode),
        npm_config_cache: join(tmpRoot, "npm-cache"),
      },
      encoding: "utf8",
      timeout,
    });

  const web = installedCommand(["web"]);
  if (
    web.status === 0 ||
    !`${web.stdout ?? ""}\n${web.stderr ?? ""}`.includes(
      "The Web GUI is not included in the OpenTUI beta",
    )
  ) {
    throw new Error(
      `Installed OpenTUI beta did not fail honestly for the deferred Web GUI:\n${web.stdout ?? ""}${web.stderr ?? ""}`,
    );
  }

  for (const [mode, expected] of [
    ["offline", "mock release channel offline"],
    ["timeout", "mock release channel timed out"],
    ["http-error", "HTTP 503 Mock Unavailable"],
  ]) {
    const failed = installedCommand(["app", installedTargetSession], mode);
    if (failed.error) {
      throw new Error(
        `Installed first-run ${mode} proof did not exit cleanly: ${failed.error.message}`,
      );
    }
    const transcript = `${failed.stdout ?? ""}\n${failed.stderr ?? ""}`;
    if (
      failed.status === 0 ||
      !transcript.includes("Automatic OpenTUI runtime acquisition failed") ||
      !transcript.includes(expected) ||
      !transcript.includes("tmux-ide update --tui-binary")
    ) {
      throw new Error(
        `Installed first-run ${mode} failure was not bounded and actionable (${failed.status}):\n${transcript}`,
      );
    }
    if (existsSync(daemonInfo)) {
      throw new Error(`Installed first-run ${mode} failure started a persistent daemon`);
    }
  }

  const downloadedDir = join(homeDir, ".tmux-ide", "bin");
  if (
    existsSync(downloadedDir) &&
    readdirSync(downloadedDir).some((name) => name.startsWith("tmux-ide-tui-"))
  ) {
    throw new Error("Failed automatic acquisition left a runtime in the clean install HOME");
  }

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
    "Automatic OpenTUI runtime acquisition failed",
    "tmux-ide update --tui-binary",
  ]) {
    if (!installedBundle.includes(required)) {
      throw new Error(`Installed CLI is missing required release contract: ${required}`);
    }
  }
  const contenders = Array.from({ length: 12 }, () => spawnInstalledCli(installedCli));

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
  await runPackedGoldenJourney(installedCli, owner);
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
  rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(tmuxTmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

if (cleanupError) throw cleanupError;
