import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const execute = promisify(execFile);
const OUTPUT_LIMIT = 64 * 1024;
const parseVersion = (value) => {
  if (typeof value !== "string" || !/^\d{1,3}\.\d{1,3}(?:\.\d{1,3})?$/.test(value))
    throw new Error("Invalid macOS version");
  return value.split(".").map(Number).concat(0).slice(0, 3);
};
const older = (a, b) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
};

/**
 * Verification component, not an installer or release qualification.
 * Caller must supply independently trusted release policy and protect the staged
 * copy from mutation; the transaction core hashes that copy around verification.
 * Injected runner/host are for tests only. Production callers use the defaults.
 * No candidate executable is run. Developer/ad-hoc signatures are insufficient.
 */
export async function verifyMacApp(
  appPath,
  policy,
  {
    runner = execute,
    platform = process.platform,
    architecture = process.arch,
    expectedVersion,
  } = {},
) {
  if (
    expectedVersion !== undefined &&
    (typeof expectedVersion !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(expectedVersion) ||
      expectedVersion.includes(".."))
  )
    throw new Error("Invalid expected release version");
  if (platform !== "darwin") throw new Error("macOS verification requires macOS");
  if (
    !policy ||
    !/^[A-Z0-9]{10}$/.test(policy.teamId ?? "") ||
    !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(policy.bundleId ?? "") ||
    !["arm64", "x86_64"].includes(policy.architecture)
  )
    throw new Error("Explicit Apple team, bundle identity and architecture policy required");
  const floor = parseVersion(policy.minimumMacOS);
  const hostArchitecture = architecture === "x64" ? "x86_64" : architecture;
  if (hostArchitecture !== policy.architecture) throw new Error("Host architecture mismatch");
  if (typeof appPath !== "string" || !isAbsolute(appPath))
    throw new Error("An absolute staged app directory is required");
  if (!(await lstat(appPath)).isDirectory()) throw new Error("Staged app must be a directory");
  const app = await realpath(appPath);
  const paths = {
    plist: join(app, "Contents/Info.plist"),
    native: join(app, "Contents/MacOS/tmux-ide-gpui"),
    node: join(app, "Contents/Resources/node"),
    launcher: join(app, "Contents/MacOS/tmux-ide-launcher"),
  };
  for (const path of Object.values(paths)) {
    if (!(await lstat(path)).isFile() || (await realpath(path)) !== path)
      throw new Error("Expected regular staged app files without redirected parents");
  }
  const deadline = performance.now() + 60_000;
  async function run(tool, args) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error("App verification deadline exceeded");
    let result;
    try {
      result = await runner(tool === "spctl" ? "/usr/sbin/spctl" : `/usr/bin/${tool}`, args, {
        timeout: Math.min(10_000, Math.ceil(remaining)),
        maxBuffer: OUTPUT_LIMIT,
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" },
        killSignal: "SIGKILL",
      });
    } catch (error) {
      throw new Error(`App verification failed: ${tool}`, { cause: error });
    }
    if (
      typeof result?.stdout !== "string" ||
      typeof result?.stderr !== "string" ||
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > OUTPUT_LIMIT
    )
      throw new Error(`Invalid or oversized verification output: ${tool}`);
    return result.stdout.trim();
  }
  const host = parseVersion(await run("sw_vers", ["-productVersion"]));
  if (older(host, floor)) throw new Error("Host macOS is below the required policy floor");
  // A disabled Gatekeeper can make assessment success meaningless.
  if ((await run("spctl", ["--status"])) !== "assessments enabled")
    throw new Error("Gatekeeper assessments must be enabled");
  const requirement = `=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${policy.teamId}" and identifier "${policy.bundleId}"`;
  await run("codesign", ["--verify", "--deep", "--strict", "-R", requirement, app]);
  const plist = async (key) => run("plutil", ["-extract", key, "raw", "-o", "-", paths.plist]);
  if (
    expectedVersion !== undefined &&
    (await plist("CFBundleShortVersionString")) !== expectedVersion
  )
    throw new Error("Bundle release version mismatch");
  if ((await plist("CFBundleIdentifier")) !== policy.bundleId)
    throw new Error("Bundle identity mismatch");
  if ((await plist("CFBundleExecutable")) !== "tmux-ide-launcher")
    throw new Error("Unsupported app launcher");
  if ((await plist("CFBundlePackageType")) !== "APPL") throw new Error("Not an app bundle");
  const bundleFloor = parseVersion(await plist("LSMinimumSystemVersion"));
  if (older(bundleFloor, floor) || older(host, bundleFloor))
    throw new Error("Bundle macOS floor is incompatible with policy or host");
  for (const path of [paths.native, paths.node]) {
    // Resources/node is outside codesign's conventional --deep nesting paths.
    await run("codesign", [
      "--verify",
      "--strict",
      "-R",
      `=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${policy.teamId}"`,
      path,
    ]);
    if ((await run("lipo", ["-archs", path])) !== policy.architecture)
      throw new Error("Executable architecture mismatch");
    const loadCommands = await run("otool", ["-l", path]);
    const targets = loadCommands
      .split(/^Load command \d+\s*$/m)
      .filter((block) => /^\s*cmd LC_(BUILD_VERSION|VERSION_MIN_MACOSX)\s*$/m.test(block));
    if (targets.length !== 1) throw new Error("Ambiguous executable macOS deployment target");
    const target = targets[0];
    const modern = /^\s*cmd LC_BUILD_VERSION\s*$/m.test(target);
    if (modern && !/^\s*platform 1\s*$/m.test(target))
      throw new Error("Executable is not a macOS target");
    const versions = [
      ...target.matchAll(modern ? /^\s*minos (\S+)\s*$/gm : /^\s*version (\S+)\s*$/gm),
    ];
    if (versions.length !== 1) throw new Error("Invalid executable deployment target");
    const deployment = parseVersion(versions[0][1]);
    if (older(host, deployment) || older(bundleFloor, deployment))
      throw new Error("Executable macOS requirement exceeds host or bundle declaration");
  }
  await run("spctl", ["--assess", "--type", "execute", app]);
  return true;
}
