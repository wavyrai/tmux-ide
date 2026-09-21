#!/usr/bin/env node
/** Build a private macOS/Linux tmux distribution, including non-system libraries. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, availableParallelism } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseLddDependencies,
  isSystemGlibc,
  minimumGlibc,
  assertElfArchitecture,
} from "./lib/linux-tmux-bundle.mjs";

if (!["darwin", "linux"].includes(process.platform))
  throw new Error("Unsupported native tmux platform");
if (!["arm64", "x64"].includes(process.arch))
  throw new Error("Unsupported native tmux architecture");
const root = fileURLToPath(new URL("../", import.meta.url));
const sourceFlag = process.argv.indexOf("--source");
const outputFlag = process.argv.indexOf("--output");
if (sourceFlag < 0 || !process.argv[sourceFlag + 1])
  throw new Error("Pass --source with the pinned tmux checkout");
const source = resolve(process.argv[sourceFlag + 1]);
const output =
  outputFlag < 0
    ? join(root, "packages/daemon/dist/native/tmux", `${process.platform}-${process.arch}`)
    : resolve(process.argv[outputFlag + 1]);
const provenance = JSON.parse(readFileSync(join(root, "native/tmux/provenance.json"), "utf8"));
const jobsFlag = process.argv.indexOf("--jobs");
const jobs =
  jobsFlag === -1
    ? Math.min(process.platform === "linux" ? 2 : 8, availableParallelism())
    : Number(process.argv[jobsFlag + 1]);
if (!Number.isSafeInteger(jobs) || jobs < 1 || jobs > 8)
  throw new Error("--jobs must be between1and8");
const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith("GIT_") && !["LD_LIBRARY_PATH", "LD_PRELOAD"].includes(key),
  ),
);
const text = (command, args, options = {}) =>
  execFileSync(command, args, { encoding: "utf8", env: childEnv, ...options }).trim();
const run = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: "inherit", env: childEnv, ...options });
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
if (text("git", ["-C", source, "rev-parse", "HEAD"]) !== provenance.commit)
  throw new Error("tmux source commit mismatch");
const patchPath = join(root, "native/tmux", provenance.patch);
if (hash(patchPath) !== provenance.patchSha256)
  throw new Error("tmux source patch checksum mismatch");
const scratch = mkdtempSync(join(tmpdir(), "tmux-ide-native-build-"));
try {
  const archive = execFileSync("git", ["-C", source, "archive", provenance.commit], {
    maxBuffer: 32 * 1024 * 1024,
    env: childEnv,
  });
  execFileSync("tar", ["-xf", "-", "-C", scratch], { input: archive, env: childEnv });
  execFileSync("git", ["apply", "-"], {
    cwd: scratch,
    input: readFileSync(patchPath),
    env: childEnv,
  });
  run("sh", ["autogen.sh"], { cwd: scratch });
  run("./configure", ["--enable-utf8proc", "--disable-jemalloc"], { cwd: scratch });
  run("make", ["-j", String(jobs)], { cwd: scratch });
  // Stage everything first. No system executable or live tmux server is touched.
  const stage = join(scratch, "bundle");
  mkdirSync(join(stage, "lib"), { recursive: true });
  const executable = join(stage, "tmux");
  copyFileSync(join(scratch, "tmux"), executable);
  chmodSync(executable, 0o755);
  const libraries = new Map();
  const names = new Map();
  const licenseFiles = [];
  mkdirSync(join(stage, "licenses"));
  const relocate = (binary, isExecutable) => {
    const ownId = isExecutable ? null : text("otool", ["-D", binary]).split("\n")[1];
    const dependencies = text("otool", ["-L", binary])
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(" (compatibility")[0]);
    for (const dependency of dependencies) {
      if (dependency === ownId) continue;
      if (dependency.startsWith("/usr/lib/") || dependency.startsWith("/System/Library/")) continue;
      if (!dependency.startsWith("/"))
        throw new Error(`Unresolved native dependency: ${dependency}`);
      const canonical = realpathSync(dependency);
      const name = basename(canonical);
      if (names.has(name) && names.get(name) !== canonical)
        throw new Error(`Native library basename collision: ${name}`);
      names.set(name, canonical);
      const target = join(stage, "lib", name);
      if (!libraries.has(canonical)) {
        libraries.set(canonical, target);
        const prefix = dirname(dirname(canonical));
        const license = ["LICENSE", "LICENSE.md", "COPYING"]
          .map((file) => join(prefix, file))
          .find(existsSync);
        if (!license) throw new Error(`Missing redistribution license for ${canonical}`);
        const licenseName = `licenses/${name}.txt`;
        copyFileSync(license, join(stage, licenseName));
        licenseFiles.push(licenseName);
        copyFileSync(canonical, target);
        chmodSync(target, 0o755);
        run("install_name_tool", ["-id", `@loader_path/${name}`, target]);
        relocate(target, false);
      }
      run("install_name_tool", [
        "-change",
        dependency,
        `${isExecutable ? "@executable_path/lib" : "@loader_path"}/${name}`,
        binary,
      ]);
    }
  };
  const linuxDependencies = [];
  if (process.platform === "darwin") {
    relocate(executable, true);
    for (const library of libraries.values()) run("codesign", ["--force", "--sign", "-", library]);
    run("codesign", ["--force", "--sign", "-", executable]);
  } else {
    const relocateElf = (binary, isExecutable) => {
      assertElfArchitecture(text("readelf", ["-h", binary]), process.arch);
      for (const dependency of parseLddDependencies(text("ldd", [binary]))) {
        if (isSystemGlibc(dependency.name)) continue;
        const canonical = realpathSync(dependency.path);
        if (names.has(dependency.name) && names.get(dependency.name) !== canonical)
          throw new Error("ELF dependency name collision");
        names.set(dependency.name, canonical);
        if (libraries.has(canonical)) continue;
        const target = join(stage, "lib", dependency.name);
        libraries.set(canonical, target);
        const candidates = [
          dependency.path,
          canonical,
          ...(canonical.startsWith("/usr/lib/") ? [canonical.slice(4)] : []),
        ];
        let owner;
        for (const path of new Set(candidates)) {
          try {
            owner = text("dpkg-query", ["-S", path], { stdio: ["ignore", "pipe", "pipe"] })
              .split("\n")[0]
              .split(": ")[0];
            break;
          } catch {
            /* merged-/usr database spelling may differ */
          }
        }
        if (!owner) throw new Error(`No package ownership for ELF dependency: ${dependency.name}`);
        const packageName = owner.split(":")[0];
        const license = join("/usr/share/doc", packageName, "copyright");
        if (!existsSync(license))
          throw new Error(`Missing ELF redistribution license: ${packageName}`);
        const licenseName = `licenses/${dependency.name}.txt`;
        copyFileSync(license, join(stage, licenseName));
        licenseFiles.push(licenseName);
        copyFileSync(canonical, target);
        chmodSync(target, 0o755);
        linuxDependencies.push({
          name: dependency.name,
          package: owner,
          version: text("dpkg-query", ["-W", "-f=${Version}", owner]),
        });
        relocateElf(target, false);
      }
      run("patchelf", ["--set-rpath", isExecutable ? "$ORIGIN/lib" : "$ORIGIN", binary]);
    };
    relocateElf(executable, true);
  }
  if (text(executable, ["-V"]) !== `tmux ${provenance.version}`)
    throw new Error("Bundled tmux version mismatch");
  const files = [
    "tmux",
    ...[...libraries.values()].map((path) => `lib/${basename(path)}`),
    ...licenseFiles,
  ];
  const minimumVersions =
    process.platform !== "darwin"
      ? []
      : [executable, ...libraries.values()].flatMap((binary) => {
          const commands = text("otool", ["-l", binary]).split(/Load command \d+/u);
          const versions = commands.flatMap((command) => {
            if (/cmd LC_BUILD_VERSION\b/u.test(command)) {
              if (!/platform (?:1|MACOS)\s/u.test(command))
                throw new Error(`Non-macOS Mach-O platform in ${binary}`);
              const version = /minos (\d+\.\d+(?:\.\d+)?)/u.exec(command)?.[1];
              if (!version) throw new Error(`Missing Mach-O minimum OS in ${binary}`);
              return [version];
            }
            if (/cmd LC_VERSION_MIN_MACOSX\b/u.test(command)) {
              const version = /version (\d+\.\d+(?:\.\d+)?)/u.exec(command)?.[1];
              if (!version) throw new Error(`Missing Mach-O minimum OS in ${binary}`);
              return [version];
            }
            return [];
          });
          if (versions.length === 0) throw new Error(`No macOS load command in ${binary}`);
          return versions;
        });
  // A low compiler deployment target cannot lower the requirement of a
  // Homebrew dependency. Record the highest load-command floor in the bundle.
  const minimumMacOS = minimumVersions
    .sort((left, right) => {
      const a = left.split(".").map(Number);
      const b = right.split(".").map(Number);
      for (let index = 0; index < 3; index += 1) {
        const difference = (a[index] ?? 0) - (b[index] ?? 0);
        if (difference !== 0) return difference;
      }
      return 0;
    })
    .at(-1);
  let nativeGridProbe;
  if (process.platform === "linux") {
    const { decodeNativeGridCapture, isNativeBootstrapCapture } =
      await import("../packages/daemon/src/terminal/mirror/native-grid-capture.ts");
    const socket = join(scratch, "probe.sock");
    let serverPid;
    try {
      run(executable, [
        "-S",
        socket,
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-s",
        "native-probe",
        "-x",
        "80",
        "-y",
        "24",
        "/bin/sh",
      ]);
      serverPid = text(executable, ["-S", socket, "display-message", "-p", "#{pid}"]);
      if (!/^\d+$/u.test(serverPid)) throw new Error("Invalid private tmux probe PID");
      run(executable, [
        "-S",
        socket,
        "send-keys",
        "-t",
        "native-probe.0",
        "-l",
        "printf 'TMUX_IDE_NATIVE_%s\\n' PROBE",
      ]);
      run(executable, ["-S", socket, "send-keys", "-t", "native-probe.0", "Enter"]);
      let captured = null;
      for (let attempt = 0; attempt < 30; attempt++) {
        captured = decodeNativeGridCapture(
          text(executable, [
            "-S",
            socket,
            "capture-pane",
            "-p",
            "-R",
            "-S",
            "-",
            "-t",
            "native-probe.0",
          ]),
        );
        if (
          captured &&
          isNativeBootstrapCapture(captured) &&
          captured.grid.some((row) =>
            row.cells
              .map((cell) => cell.text)
              .join("")
              .includes("TMUX_IDE_NATIVE_PROBE"),
          )
        )
          break;
        captured = null;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!captured) throw new Error("Patched native-grid capture qualification failed");
      nativeGridProbe = {
        version: captured.version,
        cols: captured.cols,
        rows: captured.rows,
        decoded: true,
      };
    } finally {
      if (serverPid)
        run(executable, [
          "-S",
          socket,
          "if-shell",
          "-F",
          `#{==:#{pid},${serverPid}}`,
          "kill-server",
        ]);
    }
  }
  const manifest = {
    ...provenance,
    ...(process.platform === "darwin"
      ? { minimumMacOS }
      : {
          minimumGlibc: minimumGlibc(
            [executable, ...libraries.values()].map((binary) =>
              text("readelf", ["--version-info", binary]),
            ),
          ),
          dependencies: linuxDependencies,
          compiler: text("cc", ["--version"]).split("\n")[0],
          systemLibc: text("getconf", ["GNU_LIBC_VERSION"]),
        }),
    ...(nativeGridProbe ? { nativeGridProbe } : {}),
    platform: process.platform,
    arch: process.arch,
    files: Object.fromEntries(files.map((name) => [name, hash(join(stage, name))])),
  };
  // Replacing signed Mach-O contents in place can leave macOS validating the
  // previous inode's code signature and kill an otherwise valid replacement.
  // Publish a complete verified directory with fresh inodes on the same volume.
  mkdirSync(dirname(output), { recursive: true });
  const next = mkdtempSync(join(dirname(output), ".tmux-next-"));
  const backup = mkdtempSync(join(dirname(output), ".tmux-previous-"));
  const previous = join(backup, "bundle");
  let installed = false;
  let movedPrevious = false;
  let verified = false;
  try {
    mkdirSync(join(next, "lib"));
    mkdirSync(join(next, "licenses"));
    for (const name of files) copyFileSync(join(stage, name), join(next, name));
    copyFileSync(join(root, "native/tmux/COPYING"), join(next, "COPYING"));
    writeFileSync(join(next, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    if (text(join(next, "tmux"), ["-V"]) !== `tmux ${provenance.version}`)
      throw new Error("Staged bundled tmux version mismatch");
    if (existsSync(output)) {
      renameSync(output, previous);
      movedPrevious = true;
    }
    renameSync(next, output);
    installed = true;
    if (text(join(output, "tmux"), ["-V"]) !== `tmux ${provenance.version}`)
      throw new Error("Published bundled tmux version mismatch");
    verified = true;
  } catch (error) {
    if (installed) rmSync(output, { recursive: true, force: true });
    if (movedPrevious) renameSync(previous, output);
    throw error;
  } finally {
    rmSync(next, { recursive: true, force: true });
    // Preserve the prior distribution if an exceptional rollback itself failed.
    if (!existsSync(previous) || verified) rmSync(backup, { recursive: true, force: true });
  }
  console.log(`Built ${join(output, "tmux")}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
