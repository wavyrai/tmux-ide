#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import yaml from "js-yaml";

const [, , primaryPath, secondaryPath, outputPath] = process.argv;

if (!primaryPath || !secondaryPath || !outputPath) {
  console.error("Usage: merge-update-manifests <primary.yml> <secondary.yml> <output.yml>");
  process.exit(2);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readManifest(filePath) {
  const manifest = yaml.load(readFileSync(filePath, "utf-8"));
  if (!manifest || typeof manifest !== "object") {
    fail(`Invalid manifest: ${filePath}`);
  }
  if (!Array.isArray(manifest.files)) {
    fail(`Missing files array: ${filePath}`);
  }
  return manifest;
}

const primary = readManifest(primaryPath);
const secondary = readManifest(secondaryPath);

if (primary.version !== secondary.version) {
  fail(`Version mismatch: ${primary.version} vs ${secondary.version}`);
}

if (primary.releaseDate !== secondary.releaseDate) {
  fail(`Release date mismatch: ${primary.releaseDate} vs ${secondary.releaseDate}`);
}

const seenUrls = new Set();
const mergedFiles = [];

for (const entry of [...primary.files, ...secondary.files]) {
  if (!entry || typeof entry.url !== "string") continue;
  const existing = seenUrls.has(entry.url);
  if (existing) continue;
  seenUrls.add(entry.url);
  mergedFiles.push(entry);
}

if (mergedFiles.length === 0) {
  fail("Merged manifest has no files");
}

const merged = { ...primary, files: mergedFiles };
writeFileSync(outputPath, yaml.dump(merged, { lineWidth: -1 }));
console.log(
  `Merged ${primaryPath} + ${secondaryPath} -> ${outputPath} (${mergedFiles.length} files)`,
);
