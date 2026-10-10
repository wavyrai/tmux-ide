import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readlink,
  realpath,
  rm,
  lstat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { main } from "./install-cli.mjs";
const cli = fileURLToPath(new URL("./install-cli.mjs", import.meta.url));
const policy = {
  teamId: "ABCDE12345",
  bundleId: "com.example.preview",
  architecture: "arm64",
  minimumMacOS: "14.2",
};
async function fixture(run) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gpui-install-cli-")));
  const app = join(root, "Staged.app"),
    prefix = join(root, "managed"),
    policyPath = join(root, "policy.json");
  await mkdir(app);
  await writeFile(join(app, "payload"), "first");
  await writeFile(policyPath, JSON.stringify(policy));
  try {
    await run({ root, app, prefix, policyPath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const args = (command, f, version = "v1") => [
  command,
  "--prefix",
  f.prefix,
  ...(["install", "update"].includes(command) ? ["--app", f.app, "--version", version] : []),
  ...(["install", "update", "rollback"].includes(command) ? ["--policy", f.policyPath] : []),
];
const injected = { platform: "darwin", verify: async () => true };
test("synthetic verified lifecycle installs, repeats, upgrades, re-verifies rollback and detaches without deleting", async () => {
  await fixture(async (f) => {
    const copies = [];
    const deps = {
      platform: "darwin",
      verify: async (copy, p) => {
        copies.push(copy);
        assert.deepEqual(p, policy);
        assert.notEqual(copy, f.app);
        await readFile(join(copy, "payload"));
        return true;
      },
    };
    assert.equal((await main(args("install", f), deps)).exitCode, 0);
    assert.equal((await main(args("install", f), deps)).output.result.repeated, true);
    await writeFile(join(f.app, "payload"), "second");
    assert.equal((await main(args("update", f, "v2"), deps)).output.result.previous, "v1");
    assert.equal((await main(args("rollback", f), deps)).output.result.version, "v1");
    assert.equal(copies.length, 4);
    assert.equal(await readlink(join(f.prefix, "current")), "versions/v1/TmuxIDE.app");
    await writeFile(join(f.prefix, "config"), "untouched");
    const detached = await main(args("uninstall", f), deps);
    assert.equal(detached.exitCode, 0);
    assert.deepEqual(detached.output.result.retained, ["v1", "v2"]);
    assert.match(detached.output.message, /versions retained/);
    assert.equal(await readFile(join(f.prefix, "config"), "utf8"), "untouched");
    await assert.rejects(lstat(join(f.prefix, "current")), { code: "ENOENT" });
  });
});
test("strict parser and platform failures make no installation or verifier calls", async () => {
  await fixture(async (f) => {
    let called = 0;
    const deps = {
      platform: "darwin",
      verify: async () => {
        called++;
        return true;
      },
    };
    for (const command of [
      [],
      ["install"],
      ["install", "--prefix", f.prefix, "--prefix", f.prefix],
      [...args("install", f), "--skip-verify", "yes"],
      [...args("install", f), "--unknown", "x"],
      args("install", f, "../escape"),
      ["recover", "--prefix", f.prefix, "--policy", f.policyPath],
      ["recover", "--prefix", f.prefix, "--policy", f.policyPath, "--disposition", "auto"],
      [
        "recover",
        "--prefix",
        f.prefix,
        "--policy",
        f.policyPath,
        "--disposition",
        "keep-current",
        "--skip-verify",
        "yes",
      ],
      ["detach", "--prefix", f.prefix, "--policy", f.policyPath],
    ]) {
      assert.equal((await main(command, deps)).output.error.code, "arguments");
    }
    assert.equal(
      (await main(args("install", f), { ...deps, platform: "linux" })).output.error.code,
      "platform",
    );
    assert.equal((await main(["--help"], deps)).exitCode, 0);
    assert.equal(called, 0);
    await assert.rejects(lstat(f.prefix), { code: "ENOENT" });
  });
});
test("policy rejects extra keys, oversized, private syntax and candidate-owned input before mutation", async () => {
  await fixture(async (f) => {
    for (const body of [
      "private-secret{",
      JSON.stringify({ ...policy, skip: true }),
      " ".repeat(8193),
      JSON.stringify({ ...policy, teamId: 'x" or true' }),
    ]) {
      await writeFile(f.policyPath, body);
      const result = await main(args("install", f), injected);
      assert.equal(result.output.error.code, "policy");
      assert.ok(!JSON.stringify(result).includes("private-secret"));
      await assert.rejects(lstat(f.prefix), { code: "ENOENT" });
    }
    const inside = join(f.app, "policy.json");
    await writeFile(inside, JSON.stringify(policy));
    assert.equal(
      (await main(args("install", { ...f, policyPath: inside }), injected)).output.error.code,
      "policy",
    );
  });
});
test("verification denial preserves current, lock refuses, symlink root refuses and tmp alias is canonicalized", async () => {
  await fixture(async (f) => {
    // Exercise the same parent-symlink normalization as macOS /tmp, on every host.
    const aliasRoot = join(f.root, "parent-alias");
    await symlink(f.root, aliasRoot);
    const alias = {
      ...f,
      app: join(aliasRoot, "Staged.app"),
      prefix: join(aliasRoot, "managed"),
      policyPath: join(aliasRoot, "policy.json"),
    };
    assert.equal((await main(args("install", alias), injected)).exitCode, 0);
    const denied = await main(args("update", f, "v2"), {
      platform: "darwin",
      verify: async () => {
        throw new Error("secret-signature-output");
      },
    });
    assert.equal(denied.output.error.code, "verification");
    assert.ok(!JSON.stringify(denied).includes("secret-signature"));
    assert.equal(await readlink(join(f.prefix, "current")), "versions/v1/TmuxIDE.app");
    await mkdir(join(f.prefix, ".transaction-lock"));
    assert.equal((await main(args("detach", f), injected)).output.error.code, "locked");
    const link = join(f.root, "link");
    await symlink(f.prefix, link);
    assert.equal(
      (await main(args("detach", { ...f, prefix: link }), injected)).output.error.code,
      "transaction",
    );
  });
});
test("executable help and invalid arguments emit bounded JSON without side effects", async () => {
  await fixture(async (f) => {
    const run = promisify(execFile);
    const options = {
      timeout: 5000,
      maxBuffer: 65536,
      env: { PATH: "/usr/bin:/bin", HOME: f.root },
    };
    const result = await run(process.execPath, [cli, "--help"], options);
    assert.equal(JSON.parse(result.stdout).ok, true);
    assert.equal(result.stderr, "");
    await assert.rejects(
      run(
        process.execPath,
        [cli, "install", "--prefix", f.prefix, "--skip-verify", "true"],
        options,
      ),
      (error) => {
        assert.equal(error.code, 1);
        assert.equal(JSON.parse(error.stdout).error.code, "arguments");
        assert.equal(error.stderr, "");
        return true;
      },
    );
    await assert.rejects(lstat(f.prefix), { code: "ENOENT" });
  });
});

test("FIFO policy is rejected without waiting for a writer", async () => {
  await fixture(async (f) => {
    const fifo = join(f.root, "policy-fifo");
    await promisify(execFile)("/usr/bin/mkfifo", [fifo], { timeout: 2000 });
    const child = promisify(execFile);
    await assert.rejects(
      child(process.execPath, [cli, ...args("install", { ...f, policyPath: fifo })], {
        timeout: 3000,
        maxBuffer: 65536,
      }),
      (error) => {
        assert.equal(error.code, 1);
        assert.equal(
          JSON.parse(error.stdout).error.code,
          process.platform === "darwin" ? "policy" : "platform",
        );
        return true;
      },
    );
    await assert.rejects(lstat(f.prefix), { code: "ENOENT" });
  });
});
test("script symlink invocation executes help rather than silently returning success", async () => {
  await fixture(async (f) => {
    const link = join(f.root, "installer.mjs");
    await symlink(cli, link);
    const result = await promisify(execFile)(process.execPath, [link, "--help"], {
      timeout: 5000,
      maxBuffer: 65536,
    });
    assert.equal(JSON.parse(result.stdout).ok, true);
  });
});

test("relative destination cannot detach an existing installation", async () => {
  await fixture(async (f) => {
    assert.equal((await main(args("install", f), injected)).exitCode, 0);
    const result = await main(["detach", "--prefix", relative(process.cwd(), f.prefix)], injected);
    assert.equal(result.exitCode, 1);
    assert.equal(result.output.error.code, "arguments");
    assert.equal(await readlink(join(f.prefix, "current")), "versions/v1/TmuxIDE.app");
    assert.equal((await main(args("detach", f), injected)).exitCode, 0);
    await assert.rejects(lstat(join(f.prefix, "current")), { code: "ENOENT" });
  });
});

test("release mode authenticates offer before installer seam and removes only empty owned staging", async () => {
  const { generateKeyPairSync, sign } = await import("node:crypto");
  const { createManifest } = await import("./preview-release-manifest.mjs");
  const keys = generateKeyPairSync("ed25519");
  const raw = keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const releasePolicy = {
    ...policy,
    releasePublicKey: raw.toString("hex"),
    releaseBaseUrl: "https://fixture.invalid/releases/",
    redirectOrigins: [],
  };
  const manifest = createManifest({ version: "v1", archiveSize: 123, sha256: "a".repeat(64) }),
    signature = sign(null, manifest, keys.privateKey);
  await fixture(async (f) => {
    await writeFile(f.policyPath, JSON.stringify(releasePolicy));
    const command = ["install", "--prefix", f.prefix, "--policy", f.policyPath, "--version", "v1"];
    let calls = 0,
      staging;
    const deps = {
      platform: "darwin",
      fetchImpl: async (url) => new Response(url.endsWith(".sig") ? signature : manifest),
      releaseInstaller: async (opts) => {
        calls++;
        staging = opts.destinationRoot;
        assert.equal((await lstat(staging)).mode & 0o077, 0);
        assert.equal(opts.installRoot, f.prefix);
        assert.deepEqual(opts.applePolicy, policy);
        assert.equal(opts.baseUrl, "https://fixture.invalid/releases/v1/");
        assert.deepEqual(opts.policy.publicKey, raw);
        assert.equal(opts.policy.expectedVersion, "v1");
        return { version: "v1", repeated: false };
      },
    };
    const result = await main(command, deps);
    assert.equal(result.exitCode, 0);
    assert.equal(result.output.mode, "release");
    assert.equal(calls, 1);
    await assert.rejects(lstat(staging), { code: "ENOENT" });
    for (const bad of [Buffer.alloc(64), signature.subarray(1)]) {
      const result = await main(command, {
        ...deps,
        fetchImpl: async (url) => new Response(url.endsWith(".sig") ? bad : manifest),
      });
      assert.equal(result.output.error.code, "offer");
      assert.equal(calls, 1);
    }
    // Extended policy remains compatible with local verification: only Apple fields reach it.
    assert.equal(
      (
        await main(args("install", f), {
          platform: "darwin",
          verify: async (copy, p) => {
            assert.deepEqual(p, policy);
            return true;
          },
        })
      ).exitCode,
      0,
    );
  });
});
test("release policy is exact, bounded and mandatory; unknown metadata cannot reach installer", async () => {
  await fixture(async (f) => {
    const command = ["update", "--prefix", f.prefix, "--policy", f.policyPath, "--version", "v1"];
    let calls = 0;
    const deps = {
      platform: "darwin",
      fetchImpl: async () => {
        calls++;
        throw new Error("unexpected");
      },
      releaseInstaller: async () => {
        assert.fail("must not install");
      },
    };
    const valid = {
      ...policy,
      releasePublicKey: "a".repeat(64),
      releaseBaseUrl: "https://fixture.invalid/releases/",
      redirectOrigins: [],
    };
    for (const value of [
      policy,
      { ...valid, extra: true },
      { ...valid, releasePublicKey: "A".repeat(64) },
      { ...valid, releaseBaseUrl: "http://fixture.invalid/" },
      { ...valid, releaseBaseUrl: "https://fixture.invalid/?token=private" },
      { ...valid, redirectOrigins: ["https://cdn.invalid/path"] },
    ]) {
      await writeFile(f.policyPath, JSON.stringify(value));
      const r = await main(command, deps);
      assert.equal(r.output.error.code, "policy");
      assert.ok(!JSON.stringify(r).includes("private" + '"'));
    }
    assert.equal(calls, 0);
    await assert.rejects(lstat(f.prefix), { code: "ENOENT" });
  });
});
test("release failure preserves activation disposition and never erases unexpected staging leftovers", async () => {
  const { generateKeyPairSync, sign } = await import("node:crypto");
  const { createManifest } = await import("./preview-release-manifest.mjs");
  const keys = generateKeyPairSync("ed25519");
  const raw = keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const manifest = createManifest({ version: "v1", archiveSize: 1, sha256: "a".repeat(64) }),
    signature = sign(null, manifest, keys.privateKey);
  await fixture(async (f) => {
    await writeFile(
      f.policyPath,
      JSON.stringify({
        ...policy,
        releasePublicKey: raw.toString("hex"),
        releaseBaseUrl: "https://fixture.invalid/",
        redirectOrigins: [],
      }),
    );
    const command = ["install", "--prefix", f.prefix, "--policy", f.policyPath, "--version", "v1"];
    const fetchImpl = async (url) => new Response(url.endsWith(".sig") ? signature : manifest);
    for (const activationState of ["confirmed", "unknown"]) {
      let staging;
      const result = await main(command, {
        platform: "darwin",
        fetchImpl,
        releaseInstaller: async (opts) => {
          staging = opts.destinationRoot;
          throw Object.assign(new Error("PRIVATE_ERROR"), { activationState });
        },
      });
      assert.equal(result.output.error.activationState, activationState);
      assert.ok(!JSON.stringify(result).includes("PRIVATE_ERROR"));
      await assert.rejects(lstat(staging), { code: "ENOENT" });
    }
    let retained;
    const result = await main(command, {
      platform: "darwin",
      fetchImpl,
      releaseInstaller: async (opts) => {
        retained = opts.destinationRoot;
        await writeFile(join(retained, "unexpected"), "preserve");
        return { version: "v1" };
      },
    });
    assert.equal(result.output.error.code, "cleanup");
    assert.equal(result.output.error.activationState, "confirmed");
    assert.equal(result.output.error.stagingRetained, true);
    assert.equal(await readFile(join(retained, "unexpected"), "utf8"), "preserve");
    await rm(retained, { recursive: true });
    const both = await main(command, {
      platform: "darwin",
      fetchImpl,
      releaseInstaller: async (opts) => {
        retained = opts.destinationRoot;
        await writeFile(join(retained, "unexpected"), "preserve");
        throw Object.assign(new Error("PRIVATE_ORIGINAL"), { activationState: "unknown" });
      },
    });
    assert.equal(both.output.error.code, "cleanup");
    assert.equal(both.output.error.priorFailure, "release");
    assert.equal(both.output.error.activationState, "unknown");
    assert.ok(!JSON.stringify(both).includes("PRIVATE_ORIGINAL"));
    assert.equal(await readFile(join(retained, "unexpected"), "utf8"), "preserve");
    await rm(retained, { recursive: true });
  });
});
test("release cancellation before/during offer creates no staging; transaction cancellation preserves disposition", async () => {
  const { generateKeyPairSync, sign } = await import("node:crypto");
  const { readdir } = await import("node:fs/promises");
  const { createManifest } = await import("./preview-release-manifest.mjs");
  const keys = generateKeyPairSync("ed25519");
  const raw = keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const manifest = createManifest({ version: "v1", archiveSize: 1, sha256: "a".repeat(64) });
  const signature = sign(null, manifest, keys.privateKey);
  const staged = async () =>
    (await readdir(await realpath(tmpdir())))
      .filter((name) => name.startsWith("tmux-gpui-release-"))
      .sort();
  await fixture(async (f) => {
    await writeFile(
      f.policyPath,
      JSON.stringify({
        ...policy,
        releasePublicKey: raw.toString("hex"),
        releaseBaseUrl: "https://fixture.invalid/",
        redirectOrigins: [],
      }),
    );
    const command = ["update", "--prefix", f.prefix, "--policy", f.policyPath, "--version", "v1"];
    for (const preAborted of [true, false]) {
      const before = await staged();
      const controller = new AbortController();
      let calls = 0;
      if (preAborted) controller.abort();
      const result = await main(command, {
        platform: "darwin",
        signal: controller.signal,
        fetchImpl: async () => {
          calls++;
          controller.abort();
          return new Promise(() => {});
        },
        releaseInstaller: async () => assert.fail("installer must not run"),
      });
      assert.equal(result.exitCode, 1);
      assert.equal(result.output.error.code, "cancelled");
      assert.equal(calls, preAborted ? 0 : 1);
      assert.deepEqual(await staged(), before);
      await assert.rejects(lstat(f.prefix), { code: "ENOENT" });
    }
    const controller = new AbortController();
    let staging;
    const result = await main(command, {
      platform: "darwin",
      signal: controller.signal,
      fetchImpl: async (url) => new Response(url.endsWith(".sig") ? signature : manifest),
      releaseInstaller: async (opts) => {
        assert.equal(opts.signal, controller.signal);
        staging = opts.destinationRoot;
        controller.abort();
        throw Object.assign(new Error("PRIVATE_CANCEL"), { activationState: "confirmed" });
      },
    });
    assert.equal(result.output.error.code, "cancelled");
    assert.equal(result.output.error.activationState, "confirmed");
    assert.match(result.output.error.message, /not rolled back/);
    assert.ok(!JSON.stringify(result).includes("PRIVATE_CANCEL"));
    await assert.rejects(lstat(staging), { code: "ENOENT" });
  });
});

test("explicit recovery refuses a legacy empty lock without verification or mutation", async () => {
  await fixture(async (f) => {
    assert.equal((await main(args("install", f), injected)).exitCode, 0);
    await mkdir(join(f.prefix, ".transaction-lock"), { mode: 0o700 });
    let calls = 0;
    const result = await main(
      ["recover", "--prefix", f.prefix, "--policy", f.policyPath, "--disposition", "keep-current"],
      {
        platform: "darwin",
        verify: async () => {
          calls++;
          return true;
        },
      },
    );
    assert.equal(result.exitCode, 1);
    assert.equal(result.output.error.code, "transaction");
    assert.equal(calls, 0);
    assert.ok((await lstat(join(f.prefix, ".transaction-lock"))).isDirectory());
    assert.equal(await readlink(join(f.prefix, "current")), "versions/v1/TmuxIDE.app");
  });
});
