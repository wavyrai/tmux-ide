import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packaged = JSON.parse(
  await readFile(join(packageRoot, "release", "package-path.json"), "utf8"),
);
const detachedRoot = await mkdtemp(join(tmpdir(), "tmux-ide-packaged-smoke-"));
const appPath = join(detachedRoot, basename(packaged.appPath));
await cp(packaged.appPath, appPath, { recursive: true, verbatimSymlinks: true });
const executablePath = join(appPath, relative(packaged.appPath, packaged.executablePath));
const daemonEntryPath =
  process.platform === "darwin"
    ? join(appPath, "Contents", "Resources", "app", "daemon-child.cjs")
    : join(appPath, "resources", "app", "daemon-child.cjs");

const baseEnvironment = { ...process.env };
delete baseEnvironment.TMUX_IDE_RENDERER_URL;
delete baseEnvironment.NODE_PATH;

function exists(path) {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitUntil(predicate, timeoutMs, detail) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${detail}`);
}

async function createIsolatedRuntime(label) {
  const root = await mkdtemp(join(tmpdir(), `tmux-ide-${label}-`));
  const home = join(root, "home");
  const canonical = join(root, "canonical");
  const registry = join(root, "registry");
  const userData = join(root, "electron-user-data");
  const socket = join(root, "tmux.sock");
  const sessionName = `desktop-${label}`;
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(canonical, { recursive: true, mode: 0o700 }),
    mkdir(registry, { recursive: true, mode: 0o700 }),
    mkdir(userData, { recursive: true }),
  ]);
  await execFileAsync("tmux", ["-S", socket, "new-session", "-d", "-s", sessionName]);
  const { stdout } = await execFileAsync("tmux", [
    "-S",
    socket,
    "display-message",
    "-p",
    "-t",
    sessionName,
    "#{pid}",
  ]);
  const tmuxPid = Number(stdout.trim());
  if (!Number.isInteger(tmuxPid) || tmuxPid < 1) throw new Error("isolated tmux PID missing");
  return {
    root,
    socket,
    canonical,
    environment: {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      TMUX: `${socket},${tmuxPid},0`,
      TMUX_IDE_DAEMON_INFO_DIR: canonical,
      TMUX_IDE_REGISTRY_DIR: registry,
    },
    userData,
  };
}

async function readCanonical(runtime) {
  try {
    return JSON.parse(await readFile(join(runtime.canonical, "daemon.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function cleanupIsolatedRuntime(runtime) {
  const canonical = await readCanonical(runtime).catch(() => null);
  if (canonical && Number.isInteger(canonical.pid) && processIsAlive(canonical.pid)) {
    process.kill(canonical.pid, "SIGTERM");
    await waitUntil(() => !processIsAlive(canonical.pid), 3_000, "isolated daemon cleanup").catch(
      () => process.kill(canonical.pid, "SIGKILL"),
    );
  }
  await execFileAsync("tmux", ["-S", runtime.socket, "kill-server"]).catch(() => undefined);
  await rm(runtime.root, { recursive: true, force: true });
}

async function withIsolatedRuntime(label, operation) {
  const runtime = await createIsolatedRuntime(label);
  try {
    return await operation(runtime);
  } finally {
    await cleanupIsolatedRuntime(runtime);
  }
}

async function runPackaged(runtime, environment = {}, timeoutMs = 20_000) {
  const child = spawn(executablePath, ["--smoke-test", `--user-data-dir=${runtime.userData}`], {
    env: {
      ...baseEnvironment,
      ...runtime.environment,
      ...environment,
      ELECTRON_ENABLE_LOGGING: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk.toString()));
  child.stderr.on("data", (chunk) => (output += chunk.toString()));
  const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  clearTimeout(timeout);
  return { code, output };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("missing redirect test port"));
      else resolve(address.port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function startExternalDaemon(runtime) {
  const child = spawn(executablePath, [daemonEntryPath], {
    env: {
      ...baseEnvironment,
      ...runtime.environment,
      ELECTRON_RUN_AS_NODE: "1",
      TMUX_IDE_DESKTOP_PRODUCT_VERSION: "2.8.0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk.toString()));
  child.stderr.on("data", (chunk) => (output += chunk.toString()));
  await waitUntil(
    async () => {
      if (child.exitCode !== null) {
        throw new Error(`external packaged daemon exited early (${child.exitCode})\n${output}`);
      }
      const canonical = await readCanonical(runtime);
      return canonical?.pid === child.pid && output.includes('"status":"ready"');
    },
    15_000,
    "external packaged daemon readiness",
  );
  return { child, output: () => output };
}

async function stopExternalDaemon(external, runtime) {
  if (external.child.exitCode !== null) return;
  const exited = new Promise((resolve) => external.child.once("exit", resolve));
  external.child.kill("SIGTERM");
  await waitUntil(
    async () => !(await exists(join(runtime.canonical, "daemon.json"))),
    5_000,
    "external daemon graceful canonical cleanup",
  );
  // The daemon has retired all authority and its canonical generation. A
  // native/runtime handle can keep the isolated harness process resident, so
  // reap that exact test-owned child without weakening the cleanup assertion.
  if (external.child.exitCode === null) external.child.kill("SIGKILL");
  await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("external packaged daemon could not be reaped")), 5_000),
    ),
  ]);
}

try {
  let redirectRequests = 0;
  let escapedRequests = 0;
  const escaped = createServer((_request, response) => {
    escapedRequests += 1;
    response.end("redirect escaped its trusted renderer origin");
  });
  const escapedPort = await listen(escaped);
  const redirecting = createServer((_request, response) => {
    redirectRequests += 1;
    response.writeHead(302, { location: `http://127.0.0.1:${escapedPort}/escaped` });
    response.end();
  });
  const redirectingPort = await listen(redirecting);
  let redirectOutput;
  try {
    await withIsolatedRuntime("redirect", async (runtime) => {
      ({ output: redirectOutput } = await runPackaged(
        runtime,
        { TMUX_IDE_RENDERER_URL: `http://127.0.0.1:${redirectingPort}/renderer` },
        8_000,
      ));
    });
  } finally {
    await Promise.all([close(redirecting), close(escaped)]);
  }
  if (redirectRequests !== 1 || escapedRequests !== 0) {
    throw new Error(
      `packaged redirect containment failed (redirect ${redirectRequests}, escaped ${escapedRequests})\n${redirectOutput}`,
    );
  }

  await withIsolatedRuntime("owned", async (runtime) => {
    const { code, output } = await runPackaged(runtime);
    if (code !== 0 || !output.includes("tmux-ide desktop smoke ready daemon=owned")) {
      throw new Error(`packaged owned-daemon smoke failed (exit ${code})\n${output}`);
    }
    if (await exists(join(runtime.canonical, "daemon.json"))) {
      throw new Error("owned packaged daemon left its canonical generation behind");
    }
    if (await exists(join(runtime.canonical, "daemon.claim"))) {
      throw new Error("owned packaged daemon left its startup claim behind");
    }
  });

  await withIsolatedRuntime("external", async (runtime) => {
    const external = await startExternalDaemon(runtime);
    const before = await readCanonical(runtime);
    try {
      const templatesResponse = await fetch(
        `http://127.0.0.1:${before.port}/api/projects/templates`,
        { headers: { Authorization: `Bearer ${before.authToken}` } },
      );
      const templatesBody = await templatesResponse.json();
      if (
        !templatesResponse.ok ||
        !Array.isArray(templatesBody.templates) ||
        !templatesBody.templates.some((template) => template.id === "default")
      ) {
        throw new Error("detached packaged daemon could not load its bundled templates");
      }
      const { code, output } = await runPackaged(runtime);
      if (code !== 0 || !output.includes("tmux-ide desktop smoke ready daemon=attached")) {
        throw new Error(`packaged external-daemon attach smoke failed (exit ${code})\n${output}`);
      }
      const after = await readCanonical(runtime);
      if (
        external.child.exitCode !== null ||
        !before ||
        !after ||
        before.pid !== external.child.pid ||
        after.instanceId !== before.instanceId
      ) {
        throw new Error(`desktop app stopped or replaced an external daemon\n${external.output()}`);
      }
    } finally {
      await stopExternalDaemon(external, runtime);
    }
    await waitUntil(
      async () => !(await exists(join(runtime.canonical, "daemon.json"))),
      3_000,
      "external daemon canonical cleanup",
    );
  });

  console.log("Packaged desktop smoke passed (owned + external daemon lifecycle)");
} finally {
  await rm(detachedRoot, { recursive: true, force: true });
}
