import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm, chmod, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLocalSetup, runLocalSetup } from "./local-setup.ts";

async function fixture(version = "2.9.7") {
  const home = await realpath(await mkdtemp(join(tmpdir(), "gpui-setup-")));
  const root = join(home, ".local/share/tmux-ide");
  const release = join(root, "releases/install-abc123");
  const pkg = join(release, "npm/lib/node_modules/tmux-ide");
  const node = join(release, "node/bin/node");
  const cli = join(pkg, "bin/cli.js");
  await mkdir(join(pkg, "bin"), { recursive: true });
  await mkdir(join(release, "node/bin"), { recursive: true });
  await writeFile(node, "fake executable; never executed", { mode: 0o700 });
  await writeFile(cli, "fake CLI; never executed");
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({ name: "tmux-ide", version, bin: { "tmux-ide": "bin/cli.js" } }),
  );
  await writeFile(join(root, "installer-v1"), "1\n");
  await writeFile(join(release, ".installer-release-v1"), "1\n");
  await symlink(release, join(root, "current"));
  return {
    home,
    root,
    release,
    pkg,
    node,
    cli,
    close: () => rm(home, { recursive: true, force: true }),
  };
}
const ready = (version: string) =>
  JSON.stringify({
    ok: true,
    status: "ready",
    productVersion: version,
    instanceId: "private-fixture-owner",
  });

test("fixed managed lookup and explicit supported update use pinned paths and bounded runner", async () => {
  for (const version of ["2.9.6", "2.9.7", "2.9.8"]) {
    const f = await fixture(version);
    try {
      const result = await resolveLocalSetup({ home: f.home });
      assert.equal(result.kind, "available");
      if (result.kind !== "available") throw new Error("Unavailable fixture");
      const calls: string[][] = [];
      assert.deepEqual(
        await runLocalSetup(result.installation, {
          run: async (executable, args, options) => {
            assert.equal(executable, f.node);
            assert.equal(options.cwd, f.home);
            assert.equal(options.timeout, 15000);
            assert.equal(options.maxBuffer, 4096);
            calls.push([...args]);
            return args[1] === "--version" ? `tmux-ide v${version}\n` : ready(version);
          },
        }),
        { kind: "ready" },
      );
      assert.deepEqual(calls, [
        [f.cli, "--version"],
        [f.cli, "update", "--daemon", "--json"],
      ]);
    } finally {
      await f.close();
    }
  }
});

test("unsupported versions never execute, including newer installs and prereleases", async () => {
  for (const version of ["2.9.5", "2.9.9", "3.0.0", "2.9.8-beta.1"]) {
    const f = await fixture(version);
    try {
      assert.deepEqual(await resolveLocalSetup({ home: f.home }), { kind: "unsupported-version" });
    } finally {
      await f.close();
    }
  }
});

test("missing, redirected and invalid managed installations fail closed", async () => {
  const mutations = [
    async (f: Awaited<ReturnType<typeof fixture>>) => rm(join(f.root, "installer-v1")),
    async (f: Awaited<ReturnType<typeof fixture>>) =>
      writeFile(join(f.release, ".installer-release-v1"), "wrong"),
    async (f: Awaited<ReturnType<typeof fixture>>) => chmod(f.node, 0o600),
    async (f: Awaited<ReturnType<typeof fixture>>) => {
      await rm(f.cli);
      await symlink(f.node, f.cli);
    },
    async (f: Awaited<ReturnType<typeof fixture>>) =>
      writeFile(join(f.pkg, "package.json"), JSON.stringify({ name: "other", version: "2.9.7" })),
    async (f: Awaited<ReturnType<typeof fixture>>) => {
      await rm(join(f.root, "current"));
      await symlink(f.home, join(f.root, "current"));
    },
  ];
  for (const mutate of mutations) {
    const f = await fixture();
    try {
      await mutate(f);
      assert.deepEqual(await resolveLocalSetup({ home: f.home }), { kind: "invalid" });
    } finally {
      await f.close();
    }
  }
  const f = await fixture();
  try {
    await rm(f.root, { recursive: true });
    assert.deepEqual(await resolveLocalSetup({ home: f.home }), { kind: "missing" });
  } finally {
    await f.close();
  }
});

test("revalidation prevents replaced or forged installation execution", async () => {
  const f = await fixture();
  try {
    const result = await resolveLocalSetup({ home: f.home });
    if (result.kind !== "available") throw new Error("Unavailable fixture");
    const run = async () => {
      throw new Error("must not execute");
    };
    assert.deepEqual(await runLocalSetup({ ...result.installation }, { run }), {
      kind: "installation-changed",
    });
    await writeFile(f.cli, "replacement");
    assert.deepEqual(await runLocalSetup(result.installation, { run }), {
      kind: "installation-changed",
    });
    const fresh = await resolveLocalSetup({ home: f.home });
    if (fresh.kind !== "available") throw new Error("Unavailable fixture");
    let calls = 0;
    assert.deepEqual(
      await runLocalSetup(fresh.installation, {
        run: async () => {
          calls++;
          await writeFile(f.cli, "second replacement");
          return "tmux-ide v2.9.7";
        },
      }),
      { kind: "installation-changed" },
    );
    assert.equal(calls, 1);
  } finally {
    await f.close();
  }
});

test("only bounded exact successful receipts count; errors expose no private diagnostics", async () => {
  const f = await fixture();
  try {
    const result = await resolveLocalSetup({ home: f.home });
    if (result.kind !== "available") throw new Error("Unavailable fixture");
    for (const output of [
      "not json",
      "{}",
      ready("2.9.6"),
      "x".repeat(4097),
      JSON.stringify({
        ok: true,
        status: "ready",
        productVersion: "2.9.7",
        instanceId: "id",
        authToken: "secret",
      }),
    ]) {
      assert.deepEqual(
        await runLocalSetup(result.installation, {
          run: async (_exe, args) => (args[1] === "--version" ? "tmux-ide v2.9.7" : output),
        }),
        { kind: "invalid-response" },
      );
    }
    assert.deepEqual(
      await runLocalSetup(result.installation, {
        run: async () => {
          throw new Error("private stderr/token");
        },
      }),
      { kind: "failed" },
    );
    let calls = 0;
    assert.deepEqual(
      await runLocalSetup(result.installation, {
        run: async () => {
          calls++;
          return "tmux-ide v2.9.8";
        },
      }),
      { kind: "invalid-response" },
    );
    assert.equal(calls, 1);
  } finally {
    await f.close();
  }
});

test("abort before spawn and after setup begins means stopped waiting, never rollback", async () => {
  const f = await fixture();
  try {
    const result = await resolveLocalSetup({ home: f.home });
    if (result.kind !== "available") throw new Error("Unavailable fixture");
    const early = new AbortController();
    early.abort();
    assert.deepEqual(
      await runLocalSetup(result.installation, {
        signal: early.signal,
        run: async () => {
          throw new Error("must not execute");
        },
      }),
      { kind: "stopped-waiting" },
    );
    const controller = new AbortController();
    let calls = 0;
    assert.deepEqual(
      await runLocalSetup(result.installation, {
        signal: controller.signal,
        run: async (_exe, args) => {
          calls++;
          if (args[1] === "--version") return "tmux-ide v2.9.7";
          controller.abort();
          return ready("2.9.7");
        },
      }),
      { kind: "stopped-waiting" },
    );
    assert.equal(calls, 2);
  } finally {
    await f.close();
  }
});

test("qualified 2.9.8 still rejects mismatched executable and daemon identities", async () => {
  const f = await fixture("2.9.8");
  try {
    const result = await resolveLocalSetup({ home: f.home });
    assert.equal(result.kind, "available");
    if (result.kind !== "available") throw new Error("Unavailable fixture");
    for (const mismatch of ["executable", "daemon"]) {
      const calls: string[][] = [];
      assert.deepEqual(
        await runLocalSetup(result.installation, {
          run: async (_executable, args) => {
            calls.push([...args]);
            return args[1] === "--version"
              ? `tmux-ide v${mismatch === "executable" ? "2.9.7" : "2.9.8"}`
              : ready("2.9.7");
          },
        }),
        { kind: "invalid-response" },
      );
      assert.equal(calls.length, mismatch === "executable" ? 1 : 2);
    }
  } finally {
    await f.close();
  }
});
