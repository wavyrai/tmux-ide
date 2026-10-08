/** Dedicated CI cell-oracle evidence; no publication or native process control. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBoundaryResults } from "./boundary-results.mjs";
export const oracleSuite = "src/terminal/mirror/native-physical-cell-oracle-live.test.ts";
const sources = [
  oracleSuite,
  "src/terminal/mirror/__tests__/native-physical-cell-oracle.ts",
  "src/terminal/mirror/native-grid-capture.ts",
  "src/terminal/mirror/native-grid-projection.ts",
  "src/terminal/mirror/session-channel.ts",
];
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
export function verifyOracleEvidence(report, receipts, identity) {
  const count = verifyBoundaryResults(report, [oracleSuite]);
  assert.equal(count, 26, "Unexpected oracle inventory; review selected coverage");
  assert.equal(receipts.length, 2, "Both live scenario receipts required");
  assert.deepEqual(receipts.map((r) => r.fixture.scenario).sort(), ["cells", "tab-wrap"]);
  for (const receipt of receipts) {
    assert.equal(receipt.identity.gitHead, identity.commit);
    assert.equal(receipt.identity.sha256, identity.binarySha256);
    assert.equal(receipt.identity.sourceReceipt.files.tmux, identity.binarySha256);
    assert.deepEqual(receipt.identity.sourceReceipt.patches, identity.patches);
    assert.equal(receipt.native, true);
    assert(!receipt.failure, "Oracle recorded failure");
    assert.deepEqual(receipt.faults, []);
    assert.deepEqual(receipt.cleanup, {
      serverAbsent: true,
      status: 1,
      ownerDisposed: true,
      mirrorDisposed: true,
      errors: [],
    });
    for (const phase of ["initial", "edited"])
      assert(
        receipt.trace.some((x) => x.phase === phase),
        `Missing ${phase} checkpoint`,
      );
    for (const [name, digest] of Object.entries(identity.sources)) {
      const matches = receipt.identity.sources.filter((x) => x.name === name);
      assert.equal(matches.length, 1, `Missing source ${name}`);
      assert.equal(matches[0].sha256, digest);
    }
  }
  return count;
}
function identity(proof) {
  const manifest = JSON.parse(readFileSync(join(proof, "bundle/manifest.json")));
  const binarySha256 = hash(join(proof, "bundle/tmux"));
  assert.equal(binarySha256, manifest.files.tmux);
  return {
    commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    binarySha256,
    patches: manifest.patches,
    sources: Object.fromEntries(
      sources.map((p) => [p.replace("src/terminal/mirror/", ""), hash(join("packages/daemon", p))]),
    ),
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, proofArg] = process.argv.slice(2),
    proof = resolve(proofArg),
    out = join(proof, "oracle");
  if (mode === "prepare") {
    mkdirSync(out);
    const root = mkdtempSync("/tmp/tpo."),
      st = lstatSync(root);
    writeFileSync(
      join(out, "initial.json"),
      JSON.stringify({ ...identity(proof), root, uid: st.uid, dev: st.dev, ino: st.ino }, null, 2),
    );
    process.stdout.write(root + "\n");
  } else if (mode === "collect") {
    const initial = JSON.parse(readFileSync(join(out, "initial.json"))),
      errors = [];
    let tests = null,
      removed = false;
    try {
      const st = lstatSync(initial.root);
      assert(st.isDirectory() && !st.isSymbolicLink());
      assert.equal(dirname(initial.root), "/tmp");
      assert(initial.root.startsWith("/tmp/tpo."));
      for (const field of ["uid", "dev", "ino"]) assert.equal(st[field], initial[field]);
      assert.equal(st.uid, process.getuid());
      // Retain everything first, including raw captures and failed receipts.
      mkdirSync(join(out, "raw"));
      const directories = readdirSync(initial.root, { withFileTypes: true }).filter(
        (e) => e.isDirectory() && e.name.startsWith("tmux-physical-oracle-"),
      );
      // The sibling tmux socket directory is not a regular-file artifact.
      for (const entry of directories)
        cpSync(join(initial.root, entry.name), join(out, "raw", entry.name), {
          recursive: true,
          dereference: false,
        });
      const receipts = directories.map((e) =>
        JSON.parse(readFileSync(join(initial.root, e.name, "receipt.json"))),
      );
      assert.deepEqual(
        identity(proof),
        {
          commit: initial.commit,
          binarySha256: initial.binarySha256,
          patches: initial.patches,
          sources: initial.sources,
        },
        "Inputs changed during oracle",
      );
      tests = verifyOracleEvidence(
        JSON.parse(readFileSync(join(out, "vitest.json"))),
        receipts,
        initial,
      );
      // Only fully verified cleanup permits removal; failed roots remain evidence.
      rmSync(initial.root, { recursive: true });
      removed = true;
    } catch (error) {
      errors.push(String(error));
    }
    writeFileSync(
      join(out, "verification.json"),
      JSON.stringify(
        {
          tests,
          errors,
          temporaryRootRemoved: removed,
          scope: "Native cell oracle only; fixture server/disposal receipts, not physical paint",
        },
        null,
        2,
      ),
    );
    assert.deepEqual(errors, []);
  } else throw Error("Unknown oracle qualification mode");
}
