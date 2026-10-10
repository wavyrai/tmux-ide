import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installApp } from "./install-transaction.mjs";
import { verifyMacApp } from "./mac-app-verifier.mjs";

const policy = {
  teamId: "ABCDE12345",
  bundleId: "com.example.preview",
  architecture: "arm64",
  minimumMacOS: "14.2",
};
async function fixture(run) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gpui-verifier-")));
  const app = join(root, "Preview.app");
  for (const file of [
    "Contents/Info.plist",
    "Contents/MacOS/tmux-ide-gpui",
    "Contents/MacOS/tmux-ide-launcher",
    "Contents/Resources/node",
  ]) {
    const path = join(app, file);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "not executable; never executed");
  }
  try {
    await run(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
function commands(override = () => undefined) {
  const calls = [];
  const runner = async (tool, args, options) => {
    calls.push({ tool, args, options });
    const altered = override(tool, args);
    if (altered !== undefined) return altered;
    let stdout = "";
    if (tool.endsWith("sw_vers")) stdout = "15.0\n";
    if (args[0] === "--status") stdout = "assessments enabled\n";
    if (tool.endsWith("plutil"))
      stdout = {
        CFBundleIdentifier: policy.bundleId,
        CFBundleExecutable: "tmux-ide-launcher",
        CFBundlePackageType: "APPL",
        LSMinimumSystemVersion: "14.2",
      }[args[1]];
    if (tool.endsWith("lipo")) stdout = "arm64\n";
    if (tool.endsWith("otool"))
      stdout = "Load command 1\n cmd LC_BUILD_VERSION\n platform 1\n minos 13.5\n";
    return { stdout, stderr: "" };
  };
  return { calls, runner, platform: "darwin", architecture: "arm64" };
}
test("uses bounded system verifiers and required Apple identity, never candidate execution", async () => {
  await fixture(async (app) => {
    const deps = commands();
    assert.equal(await verifyMacApp(app, policy, deps), true);
    assert.equal(deps.calls.length, 14);
    for (const { tool, options } of deps.calls) {
      assert.ok(
        [
          "/usr/bin/codesign",
          "/usr/sbin/spctl",
          "/usr/bin/plutil",
          "/usr/bin/lipo",
          "/usr/bin/sw_vers",
          "/usr/bin/otool",
        ].includes(tool),
      );
      assert.ok(options.timeout > 0 && options.timeout <= 10000);
      assert.equal(options.maxBuffer, 65536);
      assert.equal(options.killSignal, "SIGKILL");
      assert.deepEqual(options.env, { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" });
    }
    const sign = deps.calls.find((c) => c.tool.endsWith("codesign"));
    assert.deepEqual(sign.args.slice(0, 4), ["--verify", "--deep", "--strict", "-R"]);
    assert.equal(
      sign.args[4],
      '=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "ABCDE12345" and identifier "com.example.preview"',
    );
    assert.deepEqual(deps.calls.at(-1).args.slice(0, 3), ["--assess", "--type", "execute"]);
  });
});
test("requires explicit policy and rejects hostile requirement metadata before tools", async () => {
  await fixture(async (app) => {
    for (const p of [
      undefined,
      {},
      { ...policy, teamId: 'X" or true' },
      { ...policy, bundleId: 'com.x" or true' },
      { ...policy, minimumMacOS: "14.2garbage" },
      { ...policy, architecture: "universal" },
    ]) {
      const deps = commands();
      await assert.rejects(verifyMacApp(app, p, deps));
      assert.equal(deps.calls.length, 0);
    }
    await assert.rejects(
      verifyMacApp(app, policy, { ...commands(), platform: "linux" }),
      /requires macOS/,
    );
    await assert.rejects(
      verifyMacApp(app, policy, { ...commands(), architecture: "x64" }),
      /architecture mismatch/,
    );
  });
});
test("unsigned or rejected assessment, disabled Gatekeeper, malformed and incompatible metadata fail closed", async () => {
  await fixture(async (app) => {
    const failures = [
      (tool) => {
        if (tool.endsWith("codesign")) throw new Error("unsigned");
      },
      (_tool, args) => {
        if (args[0] === "--assess") throw new Error("rejected");
      },
      (_tool, args) =>
        args[0] === "--status" ? { stdout: "assessments disabled", stderr: "" } : undefined,
      (tool) => (tool.endsWith("sw_vers") ? { stdout: "13.0", stderr: "" } : undefined),
      (tool) => (tool.endsWith("lipo") ? { stdout: "arm64 x86_64", stderr: "" } : undefined),
      ...[
        ["CFBundleIdentifier", "com.attacker.app"],
        ["CFBundleExecutable", "another-app"],
        ["CFBundlePackageType", "BNDL"],
        ["LSMinimumSystemVersion", "16.0"],
        ["LSMinimumSystemVersion", "13.0"],
        ["LSMinimumSystemVersion", "14.2\nsecret"],
      ].map(
        ([key, value]) =>
          (_tool, args) =>
            args[1] === key ? { stdout: value, stderr: "" } : undefined,
      ),
      () => ({ stdout: "x".repeat(65537), stderr: "" }),
      () => ({ stdout: "", stderr: "x".repeat(65537) }),
    ];
    for (const fail of failures) await assert.rejects(verifyMacApp(app, policy, commands(fail)));
  });
});
test("rejects redirected executable and app roots before any system command", async () => {
  await fixture(async (app) => {
    const alias = app + ".alias.app";
    await symlink(app, alias);
    const deps = commands();
    await assert.rejects(verifyMacApp(alias, policy, deps));
    await rm(join(app, "Contents/Resources/node"));
    await symlink("../MacOS/tmux-ide-gpui", join(app, "Contents/Resources/node"));
    await assert.rejects(verifyMacApp(app, policy, deps));
    assert.equal(deps.calls.length, 0);
  });
});

test("Mach-O deployment metadata must be macOS, unique and compatible with declared floor", async () => {
  await fixture(async (app) => {
    for (const metadata of [
      "",
      "Load command 1\n cmd LC_BUILD_VERSION\n platform 2\n minos 13.0\n",
      "Load command 1\n cmd LC_BUILD_VERSION\n platform 1\n minos 26.0\n",
      "Load command 1\n cmd LC_BUILD_VERSION\n platform 1\n minos 14.3\n",
      "Load command 1\n cmd LC_BUILD_VERSION\n platform 1\n minos 13.0oops\n",
      "Load command 1\n cmd LC_VERSION_MIN_MACOSX\n version 13.0\nLoad command 2\n cmd LC_VERSION_MIN_MACOSX\n version 13.0\n",
    ])
      await assert.rejects(
        verifyMacApp(
          app,
          policy,
          commands((tool) =>
            tool.endsWith("otool") ? { stdout: metadata, stderr: "" } : undefined,
          ),
        ),
      );
    assert.equal(
      await verifyMacApp(
        app,
        policy,
        commands((tool) =>
          tool.endsWith("otool")
            ? { stdout: "Load command 1\n cmd LC_VERSION_MIN_MACOSX\n version 13.0\n", stderr: "" }
            : undefined,
        ),
      ),
      true,
    );
  });
});

test("verifier composes with transaction's named staged bundle and checks nested signatures", async () => {
  await fixture(async (app) => {
    const root = join(app, "..", "managed");
    const deps = commands();
    await installApp({
      stagedApp: app,
      installRoot: root,
      version: "v1",
      verify: (copied) => verifyMacApp(copied, policy, deps),
    });
    const signatures = deps.calls.filter((c) => c.tool.endsWith("codesign"));
    assert.equal(signatures.length, 3);
    assert.ok(signatures[0].args.at(-1).endsWith("/TmuxIDE.app"));
    for (const nested of signatures.slice(1)) {
      assert.deepEqual(nested.args.slice(0, 3), ["--verify", "--strict", "-R"]);
      assert.equal(
        nested.args[3],
        '=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "ABCDE12345"',
      );
    }
    const bad = commands((tool, args) => {
      if (tool.endsWith("codesign") && args.at(-1).endsWith("/Resources/node"))
        throw new Error("invalid nested signature");
    });
    await assert.rejects(verifyMacApp(app, policy, bad), /codesign/);
  });
});

test("optional authenticated release version is checked after signature validation", async () => {
  await fixture(async (app) => {
    const deps = commands((tool, args) =>
      tool.endsWith("plutil") && args[1] === "CFBundleShortVersionString"
        ? { stdout: "preview-2", stderr: "" }
        : undefined,
    );
    assert.equal(await verifyMacApp(app, policy, { ...deps, expectedVersion: "preview-2" }), true);
    assert.ok(
      deps.calls.findIndex((c) => c.tool.endsWith("codesign")) <
        deps.calls.findIndex((c) => c.args[1] === "CFBundleShortVersionString"),
    );
    await assert.rejects(
      verifyMacApp(app, policy, { ...deps, expectedVersion: "preview-1" }),
      /version mismatch/,
    );
    for (const expectedVersion of ["", "../x", "a..b", "a/b", "a".repeat(65), 5]) {
      const invalid = commands();
      await assert.rejects(
        verifyMacApp(app, policy, { ...invalid, expectedVersion }),
        /Invalid expected/,
      );
      assert.equal(invalid.calls.length, 0);
    }
    const denied = commands((tool) => {
      if (tool.endsWith("codesign")) throw new Error("unsigned");
    });
    await assert.rejects(
      verifyMacApp(app, policy, { ...denied, expectedVersion: "preview-2" }),
      /codesign/,
    );
    assert.ok(!denied.calls.some((c) => c.args[1] === "CFBundleShortVersionString"));
  });
});
