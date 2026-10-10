#!/usr/bin/env node
// Adapted sequence: upstream/scripts/release/sign-macos.sh (Apache-2.0).
// No keychain changes, credential imports, publication or signature bypass.
import process from "node:process";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  writeFile,
  readdir,
  lstat,
  realpath,
  cp,
  rm,
  rename,
} from "node:fs/promises";
import { isAbsolute, join, dirname, basename, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { verifyMacApp } from "./mac-app-verifier.mjs";

const execute = promisify(execFile);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const native = "Contents/MacOS/tmux-ide-gpui";
const node = "Contents/Resources/node";
const historical = [
  "Contents/Resources/native-build-receipt.json",
  "Contents/Resources/assembly-manifest.json",
];
const safe = (text, max) =>
  typeof text === "string" &&
  text.length > 0 &&
  text.length <= max &&
  ![...text].some((c) => {
    const code = c.codePointAt(0);
    return code < 32 || (code >= 127 && code <= 159);
  });
async function boundedFile(path, limit) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error("Invalid input file");
    const bytes = Buffer.alloc(limit + 1);
    const { bytesRead } = await fd.read(bytes, 0, bytes.length, 0);
    if (bytesRead > limit) throw new Error("Input too large");
    return bytes.subarray(0, bytesRead);
  } finally {
    await fd.close();
  }
}
async function inventory(root) {
  const rows = [];
  let bytes = 0;
  async function visit(path) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || stat.mode & 0o7000)
      throw new Error("Unsupported app entry");
    if (rows.length >= 20000) throw new Error("App entry limit");
    const name = relative(root, path);
    if (stat.isFile()) {
      bytes += stat.size;
      if (stat.nlink !== 1 || bytes > 1024 ** 3) throw new Error("App size or links");
      rows.push([name, stat.mode & 0o777, hash(await readFile(path))]);
    } else {
      rows.push([name, stat.mode & 0o777, null]);
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
    }
  }
  await visit(root);
  return rows;
}
const inside = (root, path) => path === root || path.startsWith(`${root}/`);

/** runner injection is test-only; executable CLI always uses real Apple tools. */
export async function signPreviewApp(
  options,
  { runner = execute, platform = process.platform, architecture = process.arch } = {},
) {
  let stage = "inputs",
    output,
    staging,
    outputIdentity;
  try {
    if (platform !== "darwin") throw new Error("macOS required");
    const keys = ["app", "identity", "notaryProfile", "policy", "nodeEntitlements", "output"];
    if (!options || Object.keys(options).sort().join() !== keys.sort().join())
      throw new Error("Arguments");
    options = { ...options }; // Detach caller-owned scalar options before any asynchronous work.
    for (const key of ["app", "policy", "nodeEntitlements", "output"])
      if (!isAbsolute(options[key] ?? "")) throw new Error("Absolute paths required");
    if (
      !safe(options.identity, 256) ||
      !options.identity.startsWith("Developer ID Application: ") ||
      !safe(options.notaryProfile, 128)
    )
      throw new Error("Signing identity/profile required");
    const source = await realpath(options.app);
    if (!options.app.endsWith(".app") || !(await lstat(options.app)).isDirectory())
      throw new Error("App required");
    const destination = join(await realpath(dirname(options.output)), basename(options.output));
    if (inside(source, destination)) throw new Error("Output must be outside source");
    const policy = JSON.parse((await boundedFile(options.policy, 4096)).toString("utf8"));
    if (
      Object.keys(policy).sort().join() !== "architecture,bundleId,minimumMacOS,teamId" ||
      !["architecture", "bundleId", "minimumMacOS", "teamId"].every(
        (key) => typeof policy[key] === "string",
      ) ||
      !/^[A-Z0-9]{10}$/.test(policy.teamId) ||
      !/^com\.tmux-ide\.gpui(?:\.[a-z][a-z0-9-]{0,31})*$/.test(policy.bundleId) ||
      policy.bundleId.split(".").includes("development") ||
      policy.architecture !== "arm64" ||
      !/^\d{1,3}\.\d{1,3}(?:\.\d{1,3})?$/.test(policy.minimumMacOS)
    )
      throw new Error("Trusted policy required");
    const entitlements = await boundedFile(options.nodeEntitlements, 64 * 1024);
    const before = await inventory(source);
    for (const name of [native, node, ...historical])
      if (!before.some((r) => r[0] === name && r[2])) throw new Error("Missing assembly input");
    await mkdir(destination, { mode: 0o700 });
    output = destination;
    outputIdentity = await lstat(output);
    staging = join(output, ".staging");
    await mkdir(staging, { mode: 0o700 });
    const app = join(staging, "TmuxIDE.app"),
      entitlementPath = join(staging, "node-entitlements.plist");
    stage = "copy";
    await cp(source, app, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
    });
    if (
      JSON.stringify(before) !== JSON.stringify(await inventory(app)) ||
      JSON.stringify(before) !== JSON.stringify(await inventory(source))
    )
      throw new Error("Source/copy changed");
    await writeFile(entitlementPath, entitlements, { flag: "wx", mode: 0o600 });
    const deadline = performance.now() + 15 * 60_000;
    async function run(tool, args, timeout = 30_000) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error("Deadline");
      const result = await runner(tool, args, {
        timeout: Math.min(timeout, remaining),
        maxBuffer: 64 * 1024,
        encoding: "utf8",
        killSignal: "SIGKILL",
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          LANG: "C",
          LC_ALL: "C",
          ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
        },
      });
      if (
        typeof result?.stdout !== "string" ||
        typeof result?.stderr !== "string" ||
        Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > 64 * 1024
      )
        throw new Error("Invalid tool output");
      return result.stdout.trim();
    }
    stage = "metadata";
    const plist = join(app, "Contents/Info.plist");
    const field = (name) => run("/usr/bin/plutil", ["-extract", name, "raw", "-o", "-", plist]);
    const version = await field("CFBundleShortVersionString");
    if (
      !/^\d+\.\d+\.\d+$/.test(version) ||
      version.length > 64 ||
      (await field("CFBundleIdentifier")) !== policy.bundleId ||
      (await field("CFBundleExecutable")) !== "tmux-ide-launcher"
    )
      throw new Error("Metadata mismatch");
    await run("/usr/bin/plutil", ["-lint", entitlementPath]);
    const entitlementObject = JSON.parse(
      await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", entitlementPath]),
    );
    if (
      !entitlementObject ||
      Array.isArray(entitlementObject) ||
      typeof entitlementObject !== "object" ||
      entitlementObject["com.apple.security.get-task-allow"] === true
    )
      throw new Error("Distribution entitlement denied");
    stage = "sign-native";
    const signing = ["--force", "--sign", options.identity, "--options", "runtime", "--timestamp"];
    await run("/usr/bin/codesign", [...signing, join(app, native)]);
    stage = "sign-node";
    await run("/usr/bin/codesign", [
      ...signing,
      "--entitlements",
      entitlementPath,
      join(app, node),
    ]);
    stage = "sign-bundle";
    await run("/usr/bin/codesign", [...signing, app]);
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
    stage = "notarize";
    const zip = join(staging, "submission.zip");
    await run("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, zip]);
    const notarization = JSON.parse(
      await run(
        "/usr/bin/xcrun",
        [
          "notarytool",
          "submit",
          zip,
          "--keychain-profile",
          options.notaryProfile,
          "--wait",
          "--output-format",
          "json",
        ],
        10 * 60_000,
      ),
    );
    if (
      notarization.status !== "Accepted" ||
      typeof notarization.id !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(notarization.id)
    )
      throw new Error("Not accepted");
    stage = "staple";
    await run("/usr/bin/xcrun", ["stapler", "staple", app]);
    await run("/usr/bin/xcrun", ["stapler", "validate", app]);
    stage = "verify";
    await verifyMacApp(app, policy, {
      runner: (tool, args, opts) =>
        run(tool, args, opts.timeout).then((stdout) => ({ stdout, stderr: "" })),
      expectedVersion: version,
      platform,
      architecture,
    });
    for (const name of historical)
      if (hash(await readFile(join(app, name))) !== before.find((r) => r[0] === name)[2])
        throw new Error("Historical receipt changed");
    stage = "package";
    const archive = join(staging, `tmux-ide-gpui-${version}-macos-arm64.app.tar.gz`);
    await run(
      "/usr/bin/python3",
      [
        fileURLToPath(new URL("./preview-release-package.py", import.meta.url)),
        "--app",
        app,
        "--version",
        version,
        "--output",
        archive,
      ],
      120_000,
    );
    const receipt = {
      version: 1,
      scope:
        "Signing transformation; embedded assembly/build receipts describe pre-signing bytes, not signed build provenance",
      policy,
      releaseVersion: version,
      notarizationId: notarization.id,
      nodeEntitlementsSha256: hash(entitlements),
      sourceInventorySha256: hash(JSON.stringify(before)),
      historicalInputs: historical.map((path) => ({
        path,
        sha256: before.find((row) => row[0] === path)[2],
      })),
      executables: await Promise.all(
        [native, node].map(async (path) => ({
          path,
          beforeSha256: before.find((r) => r[0] === path)[2],
          afterSha256: hash(await readFile(join(app, path))),
        })),
      ),
      archive: { file: basename(archive), sha256: hash(await readFile(archive)) },
    };
    // Publish files only after all gates; output directory itself remains private.
    stage = "finalize";
    await rename(app, join(output, "TmuxIDE.app"));
    await rename(archive, join(output, basename(archive)));
    await writeFile(join(output, "signing-receipt.json"), JSON.stringify(receipt, null, 2) + "\n", {
      flag: "wx",
    });
    await rm(staging, { recursive: true });
    return { ok: true, output, receipt };
  } catch {
    if (output) {
      try {
        const current = await lstat(output);
        if (
          current.dev !== outputIdentity.dev ||
          current.ino !== outputIdentity.ino ||
          !current.isDirectory()
        )
          throw new Error("Ownership changed");
        await rm(output, { recursive: true });
        await mkdir(output, { mode: 0o700 });
        await writeFile(join(output, "failure.json"), JSON.stringify({ ok: false, stage }) + "\n", {
          flag: "wx",
        });
      } catch {
        return { ok: false, stage, cleanupFailed: true };
      }
    }
    return { ok: false, stage };
  }
}
export function parseSigningArgs(args) {
  const names = {
      "--app": "app",
      "--identity": "identity",
      "--notary-profile": "notaryProfile",
      "--policy": "policy",
      "--node-entitlements": "nodeEntitlements",
      "--output": "output",
    },
    result = {};
  if (args.length !== 12) throw new Error("arguments");
  for (let i = 0; i < args.length; i += 2) {
    const name = names[args[i]];
    if (!name || Object.hasOwn(result, name) || !args[i + 1]) throw new Error("arguments");
    result[name] = args[i + 1];
  }
  return result;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  let result;
  try {
    result = await signPreviewApp(parseSigningArgs(process.argv.slice(2)));
  } catch {
    result = { ok: false, stage: "arguments" };
  }
  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
}
