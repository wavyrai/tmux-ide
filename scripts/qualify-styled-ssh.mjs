import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { userInfo, release, tmpdir } from "node:os";
import {
  collectStyledSshReceipt,
  inspectStyledSshTempRoot,
  STYLED_SSH_TEST,
  verifyStyledSshReceipt,
} from "./lib/styled-ssh-qualification.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const args = process.argv.slice(2),
  options = {};
for (let i = 0; i < args.length; i += 2) {
  if (
    !["--binary", "--manifest", "--bun", "--evidence-dir"].includes(args[i]) ||
    !args[i + 1] ||
    options[args[i]]
  )
    throw Error("Expected unique --binary/--manifest/--bun/--evidence-dir absolute paths");
  options[args[i]] = args[i + 1];
}
for (const key of ["--binary", "--manifest", "--bun", "--evidence-dir"])
  if (!isAbsolute(options[key] ?? "")) throw Error(`Absolute ${key} required`);
const evidence = options["--evidence-dir"];
if (existsSync(evidence)) throw Error("Evidence directory must be new");
mkdirSync(evidence, { recursive: true, mode: 0o700 });
const record = {
  scope:
    "Required local macOS styled SSH source qualification; not installed artifact, WAN or physical paint",
  success: false,
  errors: [],
};
const save = (name, data) =>
  writeFileSync(join(evidence, name), JSON.stringify(data, null, 2) + "\n");
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 5000 }).trim();
let before, binary, bun, cancelled, child;
const nativeClosure = {};
const signals = new Map(
  ["SIGINT", "SIGTERM"].map((signal) => [
    signal,
    () => {
      cancelled = signal;
      child?.kill("SIGINT");
    },
  ]),
);
for (const [signal, handler] of signals) process.on(signal, handler);
try {
  if (process.platform !== "darwin" || process.getuid() === 0 || userInfo().shell !== "/bin/zsh")
    throw Error("Required private SSH lane needs non-root macOS account with /bin/zsh login shell");
  for (const path of ["/usr/bin/ssh", "/usr/bin/ssh-keygen", "/usr/sbin/sshd", "/bin/ps"])
    accessSync(path, constants.X_OK);
  binary = realpathSync(options["--binary"]);
  bun = realpathSync(options["--bun"]);
  accessSync(binary, constants.X_OK);
  accessSync(bun, constants.X_OK);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("TMUX") &&
        !["NODE_OPTIONS", "NODE_PATH", "BUN_OPTIONS", "FORCE_COLOR"].includes(key),
    ),
  );
  const bunVersion = execFileSync(bun, ["--version"], {
    env,
    encoding: "utf8",
    timeout: 5000,
  }).trim();
  if (bunVersion !== readFileSync(join(root, ".bun-version"), "utf8").trim())
    throw Error("Pinned Bun version required");
  const manifestPath = realpathSync(options["--manifest"]);
  if (dirname(manifestPath) !== dirname(binary))
    throw Error("Binary and manifest must share bundle directory");
  nativeClosure[manifestPath] = hash(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const provenance = JSON.parse(readFileSync(join(root, "native/tmux/provenance.json"), "utf8"));
  for (const [key, value] of Object.entries(provenance))
    if (JSON.stringify(manifest[key]) !== JSON.stringify(value))
      throw Error(`Native provenance mismatch: ${key}`);
  if (!manifest.files || manifest.files.tmux !== hash(binary))
    throw Error("Native binary manifest mismatch");
  for (const [name, expected] of Object.entries(manifest.files)) {
    const path = realpathSync(resolve(dirname(binary), name));
    if (!path.startsWith(dirname(binary) + sep) || hash(path) !== expected)
      throw Error(`Native closure mismatch: ${name}`);
    nativeClosure[resolve(dirname(binary), name)] = expected;
  }
  for (const patch of provenance.patches)
    if (hash(join(root, "native/tmux", patch.patch)) !== patch.patchSha256)
      throw Error("Native patch source mismatch");
  const paths = git(
    "ls-files",
    "packages",
    "scripts/lib",
    "native/tmux",
    "package.json",
    "tsconfig.json",
    "pnpm-lock.yaml",
    ".bun-version",
  )
    .split("\n")
    .filter(Boolean);
  paths.push("scripts/qualify-styled-ssh.mjs", "scripts/lib/styled-ssh-qualification.mjs");
  before = Object.fromEntries([...new Set(paths)].map((path) => [path, hash(join(root, path))]));
  record.identity = {
    head: git("rev-parse", "HEAD"),
    status: git("status", "--short"),
    sourceHashes: before,
    binary,
    binarySha256: hash(binary),
    manifestSha256: hash(manifestPath),
    bun,
    bunSha256: hash(bun),
    bunVersion,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
  };
  save("identity.json", record.identity);
  save("bundle-manifest.json", manifest);
  record.verifiedTemp = inspectStyledSshTempRoot(tmpdir());
  const tmp = record.verifiedTemp.root; // Fixture creates and cleans its own private child.
  Object.assign(env, {
    TMPDIR: tmp,
    NO_COLOR: "1",
    TMUX_IDE_OWNED_TERMINAL_SSH: "1",
    TMUX_IDE_STYLED_NATIVE_RECONNECT: "1",
    TMUX_IDE_TMUX_BIN: binary,
  });
  if (cancelled) throw Error("Cancelled before launch");
  const command = [
    "test",
    "--preload",
    "@opentui/solid/preload",
    "--preload",
    "./packages/daemon/test-support/opentui-renderer-preload.ts",
    `./${STYLED_SSH_TEST}`,
  ];
  record.command = [bun, ...command];
  let log = "",
    timedOut = false,
    outputExceeded = false,
    forcedClose = false,
    logWriteError;
  const outcome = await new Promise((resolveOutcome) => {
    child = spawn(bun, command, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    record.childPid = child.pid;
    let terminateTimer, killTimer;
    const interrupt = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGINT");
      terminateTimer ??= setTimeout(() => child.kill("SIGTERM"), 10_000);
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 15_000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      interrupt();
    }, 120_000);
    const data = (chunk) => {
      if (outputExceeded) return;
      if (Buffer.byteLength(log) + chunk.length > 8 * 1024 * 1024) {
        outputExceeded = true;
        interrupt();
        return;
      }
      log += chunk.toString("utf8");
      if (!logWriteError) {
        try {
          appendFileSync(join(evidence, "test.log"), chunk);
        } catch (error) {
          logWriteError = String(error);
          interrupt();
        }
      }
    };
    child.stdout.on("data", data);
    child.stderr.on("data", data);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(terminateTimer);
      clearTimeout(killTimer);
      clearTimeout(finalTimer);
      resolveOutcome(value);
    };
    const finalTimer = setTimeout(() => {
      forcedClose = true;
      // Only the creation-owned child handle is signaled; never signal receipt PIDs or an inferred group.
      child.kill("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      finish({ exitCode: child.exitCode, signal: child.signalCode, cleanupUnverified: true });
    }, 140_000);
    child.once("error", (error) => finish({ exitCode: null, signal: null, error: String(error) }));
    child.once("close", (exitCode, signal) => finish({ exitCode, signal }));
  });
  record.outcome = { ...outcome, timedOut, outputExceeded, forcedClose, cancelled, logWriteError };
  // Preserve raw receipt on nonzero exit too, before interpreting its claims.
  const collected = collectStyledSshReceipt(log, join(evidence, "fixture-receipt.json"));
  record.receiptOrigin = collected.origin;
  if (
    timedOut ||
    outputExceeded ||
    forcedClose ||
    cancelled ||
    logWriteError ||
    outcome.signal ||
    outcome.error
  )
    throw Error("Interrupted/oversized qualification; cleanup requires review");
  record.verified = verifyStyledSshReceipt(collected.receipt, {
    sourceSha256: before[STYLED_SSH_TEST],
    binarySha256: record.identity.binarySha256,
    exitCode: outcome.exitCode,
    log,
  });
  record.success = true;
} catch (error) {
  record.errors.push(String(error.stack ?? error));
} finally {
  if (before) {
    try {
      record.sourceChanges = Object.entries(before)
        .filter(([path, expected]) => hash(join(root, path)) !== expected)
        .map(([path]) => path);
      record.nativeChanges = Object.entries(nativeClosure)
        .filter(([path, expected]) => hash(path) !== expected)
        .map(([path]) => path);
      if (
        record.nativeChanges.length ||
        record.sourceChanges.length ||
        hash(binary) !== record.identity.binarySha256 ||
        hash(bun) !== record.identity.bunSha256
      )
        throw Error("Source or executable changed during qualification");
      record.identityUnchanged = true;
    } catch (error) {
      record.errors.push(String(error));
    }
  }
  record.success = record.success && record.errors.length === 0;
  save("result.json", record);
  for (const [signal, handler] of signals) process.off(signal, handler);
}
process.exitCode = record.success ? 0 : 1;
