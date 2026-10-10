import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rm,
  symlink,
  copyFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  snapshotNativeSources,
  nativeArtifactFromCargo,
  cargoDiagnosticTail,
  writeNativeBuildReceipt,
  verifyNativeBuildReceipt,
} from "./native-build-receipt.mjs";
const build = {
  scope: "local-cache-environment-not-hermetic",
  hostTarget: "aarch64-apple-darwin",
  command: [
    "build",
    "--locked",
    "--offline",
    "-p",
    "herdr-gpui",
    "--bin",
    "tmux-ide-gpui",
    "--release",
    "--message-format=json-render-diagnostics",
  ],
  cargo: { path: "/test/cargo", sha256: "a".repeat(64), version: "cargo test" },
  rustc: { path: "/test/rustc", sha256: "b".repeat(64), version: "rustc test" },
};
async function fixture(run) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gpui-native-receipt-"))),
    workspace = join(root, "workspace"),
    native = join(root, "native"),
    receiptPath = join(root, "receipt.json");
  await mkdir(workspace);
  await mkdir(join(workspace, "crates"));
  await mkdir(join(workspace, "assets"));
  for (const name of [
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "crates/main.rs",
    "assets/icon.svg",
  ])
    await writeFile(join(workspace, name), name);
  await writeFile(native, "binary bytes");
  try {
    await run({ root, workspace, native, receiptPath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function record(f) {
  return writeNativeBuildReceipt({ ...f, before: await snapshotNativeSources(f.workspace), build });
}
test("local receipt accepts copied native and excludes target and unrelated private root files", async () => {
  await fixture(async (f) => {
    await symlink("/nonexistent/cache", join(f.workspace, "target"));
    await writeFile(join(f.workspace, "private-secret"), "must not enter receipt");
    await record(f);
    const copy = join(f.root, "copy");
    await copyFile(f.native, copy);
    const result = await verifyNativeBuildReceipt(f.receiptPath, copy, f.workspace);
    assert.equal(result.sources.files.length, 5);
    assert.ok(!JSON.stringify(result).includes("private-secret"));
    await assert.rejects(record(f), { code: "EEXIST" });
  });
});
test("binary tampering and edited/new/deleted Rust or asset inputs invalidate receipt", async () => {
  for (const change of [
    async (f) => writeFile(f.native, "tampered"),
    async (f) => writeFile(join(f.workspace, "crates/main.rs"), "changed"),
    async (f) => writeFile(join(f.workspace, "crates/new.rs"), "new"),
    async (f) => rm(join(f.workspace, "assets/icon.svg")),
    async (f) => {
      await mkdir(join(f.workspace, ".cargo"));
      await writeFile(join(f.workspace, ".cargo/config.toml"), "new");
    },
  ]) {
    await fixture(async (f) => {
      await record(f);
      await change(f);
      await assert.rejects(verifyNativeBuildReceipt(f.receiptPath, f.native, f.workspace));
    });
  }
});
test("before/after mutation refuses receipt; source symlinks are not followed", async () => {
  await fixture(async (f) => {
    const before = await snapshotNativeSources(f.workspace);
    await writeFile(join(f.workspace, "crates/new.rs"), "new");
    await assert.rejects(writeNativeBuildReceipt({ ...f, before, build }), /changed during build/);
    await symlink(f.native, join(f.workspace, "assets/external"));
    await assert.rejects(snapshotNativeSources(f.workspace), /symlinks/);
  });
});
test("malformed, stale-digest and redirected receipts fail closed", async () => {
  for (const change of [
    (r) => ({ ...r, version: 2 }),
    (r) => ({ ...r, sources: { ...r.sources, sha256: "0".repeat(64) } }),
    (r) => ({ ...r, build: { ...r.build, command: ["build"] } }),
    (r) => ({ ...r, binary: { ...r.binary, bytes: -1 } }),
  ]) {
    await fixture(async (f) => {
      await record(f);
      const r = JSON.parse(await readFile(f.receiptPath, "utf8"));
      await writeFile(f.receiptPath, JSON.stringify(change(r)));
      await assert.rejects(verifyNativeBuildReceipt(f.receiptPath, f.native, f.workspace));
    });
  }
  await fixture(async (f) => {
    await record(f);
    const link = join(f.root, "link");
    await symlink(f.receiptPath, link);
    await assert.rejects(verifyNativeBuildReceipt(link, f.native, f.workspace));
  });
});

test("Cargo executable selection rejects stale guesses, wrong package and ambiguous outputs", () => {
  const message = (executable, package_id = "package", name = "tmux-ide-gpui") =>
    JSON.stringify({
      reason: "compiler-artifact",
      package_id,
      target: { name, kind: ["bin"] },
      executable,
    });
  assert.equal(
    nativeArtifactFromCargo(message("/configured/target/triple/release/tmux-ide-gpui"), "package"),
    "/configured/target/triple/release/tmux-ide-gpui",
  );
  for (const output of [
    "",
    message("/stale/target/release/tmux-ide-gpui", "wrong"),
    message("/decoy", "package", "other"),
    message("/one") + "\n" + message("/two"),
    message("relative"),
  ])
    assert.throws(() => nativeArtifactFromCargo(output, "package"));
});

test("Cargo failure preserves bounded rendered errors rather than unrelated artifact JSON", () => {
  const message = (text) =>
    JSON.stringify({ reason: "compiler-message", message: { rendered: text } });
  assert.equal(
    cargoDiagnosticTail(
      message("error: actual failure\n") +
        "\n" +
        JSON.stringify({ reason: "compiler-artifact", executable: "/not-a-diagnostic" }),
    ),
    "error: actual failure\n",
  );
  assert.equal(cargoDiagnosticTail(message("x".repeat(9000))).length, 8192);
});
