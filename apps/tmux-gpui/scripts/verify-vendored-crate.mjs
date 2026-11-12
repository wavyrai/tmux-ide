#!/usr/bin/env node
// Checks a vendored crate against the crates.io package it was copied from:
// the .crate file must have the pinned checksum, and every vendored file must
// equal the package's file of the same path unless the provenance lists it
// as modified or added. Usage:
//   node verify-vendored-crate.mjs vendor/<package>-provenance.json [--crate FILE]
// Without --crate it uses Cargo's registry cache, then downloads crateUrl.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) out.push(relative(root, path).split("\\").join("/"));
      else throw new Error(`Unsupported file type: ${path}`);
    }
  };
  walk(root);
  return out.sort();
}

/** Compares the extracted package and the vendored tree; returns findings. */
export function compare(provenance, packageDir, vendorDir) {
  const errors = [];
  const original = provenance.originalFilesSha256;
  const modified = new Set(provenance.modifiedFiles ?? []);
  // A `testLockfile` note declares the copy's own Cargo.lock, which the
  // package doesn't carry.
  const added = new Set([
    ...(provenance.addedSourceFiles ?? []),
    ...(provenance.testLockfile ? ["Cargo.lock"] : []),
  ]);
  const packaged = new Map(
    listFiles(packageDir).map((p) => [p, sha256(readFileSync(join(packageDir, p)))]),
  );
  for (const [path, hash] of Object.entries(original)) {
    if (packaged.get(path) !== hash)
      errors.push(`provenance hash differs from the package: ${path}`);
  }
  if (provenance.complete) {
    for (const path of packaged.keys()) {
      if (!(path in original)) errors.push(`package file missing from provenance: ${path}`);
    }
  }
  let identical = 0;
  const changed = [];
  for (const path of listFiles(vendorDir)) {
    const hash = sha256(readFileSync(join(vendorDir, path)));
    if (added.has(path)) continue;
    if (!(path in original)) errors.push(`unexpected vendored file: ${path}`);
    else if (hash === original[path]) {
      identical += 1;
      if (modified.has(path)) errors.push(`listed as modified but identical: ${path}`);
    } else if (modified.has(path)) changed.push(path);
    else errors.push(`changed but not listed as modified: ${path}`);
  }
  const vendored = new Set(listFiles(vendorDir));
  for (const path of [...modified, ...added]) {
    if (!vendored.has(path)) errors.push(`listed but not vendored: ${path}`);
  }
  if (provenance.complete) {
    for (const path of Object.keys(original)) {
      if (!vendored.has(path)) errors.push(`package file not vendored: ${path}`);
    }
  }
  return { errors, identical, changed, added: [...added] };
}

function crateFile(provenance, explicit) {
  if (explicit) return { path: explicit };
  const name = `${provenance.package}-${provenance.version}.crate`;
  const cache = join(process.env.CARGO_HOME ?? join(homedir(), ".cargo"), "registry", "cache");
  if (existsSync(cache)) {
    for (const index of readdirSync(cache)) {
      const path = join(cache, index, name);
      if (existsSync(path)) return { path };
    }
  }
  const url =
    provenance.crateUrl ??
    `https://static.crates.io/crates/${provenance.package}/${encodeURIComponent(name)}`;
  const temp = mkdtempSync(join(tmpdir(), "crate-"));
  const path = join(temp, name);
  execFileSync("curl", ["--fail", "--silent", "--show-error", "--location", "-o", path, url]);
  return { path, temp };
}

function main(argv) {
  const [provenancePath, flag, explicit] = argv;
  if (!provenancePath || (flag && flag !== "--crate"))
    throw new Error("usage: verify-vendored-crate.mjs PROVENANCE.json [--crate FILE]");
  const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
  const vendorDir = join(dirname(provenancePath), basename(provenancePath, "-provenance.json"));
  const crate = crateFile(provenance, explicit);
  const extracted = mkdtempSync(join(tmpdir(), "crate-src-"));
  try {
    const actual = sha256(readFileSync(crate.path));
    if (actual !== provenance.originalCrateSha256)
      throw new Error(`crate checksum ${actual} is not ${provenance.originalCrateSha256}`);
    execFileSync("tar", ["-xzf", crate.path, "-C", extracted, "--strip-components=1"]);
    const result = compare(provenance, extracted, vendorDir);
    for (const error of result.errors) console.error(`FAIL: ${error}`);
    console.log(
      `${provenance.package} ${provenance.version}: crate sha256 ${actual} matches; ` +
        `${result.identical} files identical to the package, ` +
        `${result.changed.length} modified (${result.changed.join(", ") || "none"}), ` +
        `${result.added.length} added (${result.added.join(", ") || "none"}).`,
    );
    return result.errors.length ? 1 : 0;
  } finally {
    rmSync(extracted, { recursive: true, force: true });
    if (crate.temp) rmSync(crate.temp, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main(process.argv.slice(2));
