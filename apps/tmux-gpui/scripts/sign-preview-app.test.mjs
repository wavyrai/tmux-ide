import { test } from "node:test";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  signPreviewApp as productionSignPreviewApp,
  parseSigningArgs,
} from "./sign-preview-app.mjs";
const signPreviewApp = (options, dependencies = {}) =>
  productionSignPreviewApp(options, { platform: "darwin", architecture: "arm64", ...dependencies });
const policy = {
  teamId: "ABCDE12345",
  bundleId: "com.tmux-ide.gpui.preview",
  architecture: "arm64",
  minimumMacOS: "14.2",
};
async function fixture(fn) {
  const root = await mkdtemp("/tmp/gpui-sign-test-");
  try {
    const app = join(root, "Input.app");
    for (const file of [
      "Contents/Info.plist",
      "Contents/MacOS/tmux-ide-launcher",
      "Contents/MacOS/tmux-ide-gpui",
      "Contents/Resources/node",
      "Contents/Resources/native-build-receipt.json",
      "Contents/Resources/assembly-manifest.json",
    ]) {
      await mkdir(join(app, file, ".."), { recursive: true });
      await writeFile(join(app, file), "synthetic input");
    }
    const options = {
      app,
      identity: "Developer ID Application: Test",
      notaryProfile: "private-profile",
      policy: join(root, "policy.json"),
      nodeEntitlements: join(root, "node.plist"),
      output: join(root, "output"),
    };
    await writeFile(options.policy, JSON.stringify(policy));
    await writeFile(options.nodeEntitlements, "synthetic plist");
    const calls = [];
    const runner = async (tool, args, opts) => {
      calls.push({ tool, args, opts });
      let stdout = "";
      if (tool.endsWith("plutil") && args[0] === "-extract")
        stdout = {
          CFBundleShortVersionString: "0.1.0",
          CFBundleIdentifier: policy.bundleId,
          CFBundleExecutable: "tmux-ide-launcher",
          CFBundlePackageType: "APPL",
          LSMinimumSystemVersion: "14.2",
        }[args[1]];
      if (args[0] === "-convert") stdout = "{}";
      if (tool.endsWith("codesign") && args[0] === "--force" && !args.at(-1).endsWith(".app"))
        await writeFile(args.at(-1), "synthetic signed bytes");
      if (args[0] === "notarytool")
        stdout = JSON.stringify({ status: "Accepted", id: "11111111-1111-4111-8111-111111111111" });
      if (tool.endsWith("sw_vers")) stdout = "26.0";
      if (args[0] === "--status") stdout = "assessments enabled";
      if (tool.endsWith("lipo")) stdout = "arm64";
      if (tool.endsWith("otool"))
        stdout = "Load command 0\n cmd LC_BUILD_VERSION\n platform 1\n minos 14.2\n";
      if (tool.endsWith("python3")) return execute(tool, args, opts);
      return { stdout, stderr: "" };
    };
    await fn({ options, runner, calls });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test("private signing sequence preserves historical inputs and binds transformation", () =>
  fixture(async ({ options, runner, calls }) => {
    const result = await signPreviewApp(options, { runner });
    assert.equal(result.ok, true);
    const signs = calls.filter((c) => c.args[0] === "--force");
    assert.equal(signs.length, 3);
    assert.ok(signs[0].args.at(-1).endsWith("/tmux-ide-gpui"));
    assert.ok(signs[1].args.at(-1).endsWith("/node"));
    assert.ok(signs[1].args.includes("--entitlements"));
    assert.ok(!signs[0].args.includes("--entitlements"));
    assert.ok(!signs[2].args.includes("--entitlements"));
    assert.ok(
      calls.findIndex((c) => c.args[0] === "notarytool") <
        calls.findIndex((c) => c.args[0] === "stapler"),
    );
    assert.ok(
      calls.findIndex((c) => c.args[0] === "--assess") <
        calls.findIndex((c) => c.tool.endsWith("python3")),
    );
    assert.ok(calls.every((c) => c.opts.timeout > 0 && c.opts.maxBuffer === 65536));
    const verification = calls.slice(
      calls.findIndex((c) => c.tool.endsWith("sw_vers")),
      calls.findIndex((c) => c.tool.endsWith("python3")),
    );
    assert.ok(verification.length > 0);
    assert.ok(verification.every((c) => c.opts.timeout <= 10_000));
    assert.equal(
      await readFile(join(options.app, "Contents/MacOS/tmux-ide-gpui"), "utf8"),
      "synthetic input",
    );
    assert.equal(
      await readFile(
        join(options.output, "TmuxIDE.app/Contents/Resources/native-build-receipt.json"),
        "utf8",
      ),
      "synthetic input",
    );
    assert.match(result.receipt.sourceInventorySha256, /^[0-9a-f]{64}$/);
    assert.equal(result.receipt.historicalInputs.length, 2);
    for (const historical of result.receipt.historicalInputs) {
      const original = await readFile(join(options.app, historical.path));
      assert.equal(historical.sha256, createHash("sha256").update(original).digest("hex"));
      assert.deepEqual(
        await readFile(join(options.output, "TmuxIDE.app", historical.path)),
        original,
      );
    }
    assert.notEqual(
      result.receipt.executables[0].beforeSha256,
      result.receipt.executables[0].afterSha256,
    );
    assert.ok(!JSON.stringify(result).includes("private-profile"));
    assert.equal(calls.filter((c) => c.tool.endsWith("sw_vers")).length, 2);
    assert.match(result.receipt.roundtrip.inventorySha256, /^[0-9a-f]{64}$/);
    assert.ok(!Object.hasOwn(result.receipt, "publicKey"));
    assert.ok(!(await readdir(options.output)).includes(".staging"));
  }));
for (const denied of ["sign-native", "notarize", "verify", "package"])
  test(`${denied} failure exposes only safe stage, no usable artifacts`, () =>
    fixture(async ({ options, runner }) => {
      const result = await signPreviewApp(options, {
        runner: async (tool, args, opts) => {
          if (
            (denied === "sign-native" && args[0] === "--force") ||
            (denied === "notarize" && args[0] === "notarytool") ||
            (denied === "verify" && args[0] === "--status") ||
            (denied === "package" && tool.endsWith("python3"))
          )
            throw new Error("secret tool diagnostics");
          return runner(tool, args, opts);
        },
      });
      assert.equal(result.ok, false);
      assert.equal(result.stage, denied);
      assert.deepEqual(await readdir(options.output), ["failure.json"]);
      assert.ok(!JSON.stringify(result).includes("secret"));
    }));
test("notary non-Accepted and debug entitlement fail closed before later tools", () =>
  fixture(async ({ options, runner, calls }) => {
    const result = await signPreviewApp(options, {
      runner: async (tool, args, opts) =>
        args[0] === "-convert"
          ? { stdout: '{"com.apple.security.get-task-allow":true}', stderr: "" }
          : runner(tool, args, opts),
    });
    assert.equal(result.stage, "metadata");
    assert.ok(!calls.some((c) => c.args[0] === "--force"));
    options.output += "-rejected";
    const rejected = await signPreviewApp(options, {
      runner: async (tool, args, opts) =>
        args[0] === "notarytool"
          ? { stdout: '{"status":"Invalid"}', stderr: "" }
          : runner(tool, args, opts),
    });
    assert.equal(rejected.stage, "notarize");
    assert.ok(!calls.some((c) => c.args[0] === "stapler"));
  }));
test("existing output and unknown CLI switches refuse without tool calls", () =>
  fixture(async ({ options, runner, calls }) => {
    await mkdir(options.output);
    await writeFile(join(options.output, "keep"), "untouched");
    assert.equal((await signPreviewApp(options, { runner })).ok, false);
    assert.equal(calls.length, 0);
    assert.equal(await readFile(join(options.output, "keep"), "utf8"), "untouched");
    assert.throws(() => parseSigningArgs(["--bypass"]));
  }));

test("unsupported host refuses before creating output or executing tools", () =>
  fixture(async ({ options, runner, calls }) => {
    const result = await productionSignPreviewApp(options, {
      runner,
      platform: "linux",
      architecture: "x64",
    });
    assert.deepEqual(result, { ok: false, stage: "inputs" });
    assert.equal(calls.length, 0);
    await assert.rejects(readFile(join(options.output, "failure.json")), { code: "ENOENT" });
  }));

test("caller mutation cannot change validated identity or profile across awaits", () =>
  fixture(async ({ options, runner, calls }) => {
    const result = await signPreviewApp(options, {
      runner: async (tool, args, opts) => {
        options.identity = "replaced identity";
        options.notaryProfile = "replaced profile";
        return runner(tool, args, opts);
      },
    });
    assert.equal(result.ok, true);
    for (const call of calls.filter((c) => c.args[0] === "--force"))
      assert.equal(call.args[call.args.indexOf("--sign") + 1], "Developer ID Application: Test");
    const notary = calls.find((c) => c.args[0] === "notarytool");
    assert.equal(notary.args[notary.args.indexOf("--keychain-profile") + 1], "private-profile");
  }));
test("numeric policy scalars reject before copy or signing", () =>
  fixture(async ({ options, runner, calls }) => {
    await writeFile(options.policy, JSON.stringify({ ...policy, minimumMacOS: 14.2 }));
    assert.deepEqual(await signPreviewApp(options, { runner }), { ok: false, stage: "inputs" });
    assert.equal(calls.length, 0);
    await assert.rejects(readdir(options.output), { code: "ENOENT" });
  }));

test("roundtrip rejects altered packaged bytes before final publication", () =>
  fixture(async ({ options, runner }) => {
    const result = await signPreviewApp(options, {
      runner: async (tool, args, opts) => {
        if (tool.endsWith("python3"))
          await writeFile(
            join(args[args.indexOf("--app") + 1], "Contents/Info.plist"),
            "unexpected changed content",
          );
        return runner(tool, args, opts);
      },
    });
    assert.deepEqual(result, { ok: false, stage: "roundtrip-inventory" });
    assert.deepEqual(await readdir(options.output), ["failure.json"]);
  }));
test("extracted app must independently pass Apple verification", () =>
  fixture(async ({ options, runner }) => {
    let checks = 0;
    const result = await signPreviewApp(options, {
      runner: async (tool, args, opts) => {
        if (tool.endsWith("sw_vers") && ++checks === 2)
          throw new Error("denied extracted candidate");
        return runner(tool, args, opts);
      },
    });
    assert.deepEqual(result, { ok: false, stage: "roundtrip-verify" });
    assert.deepEqual(await readdir(options.output), ["failure.json"]);
  }));
