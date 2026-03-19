import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ignore from "ignore";
import {
  buildRootNodes,
  expandNode,
  collapseNode,
  flattenVisibleNodes,
  refreshExpandedNodes,
} from "./tree-model.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tmux-ide-tree-test-"));
  mkdirSync(join(tmpDir, "src"));
  mkdirSync(join(tmpDir, "src", "lib"));
  writeFileSync(join(tmpDir, "src", "index.ts"), "");
  writeFileSync(join(tmpDir, "src", "lib", "utils.ts"), "");
  mkdirSync(join(tmpDir, "docs"));
  writeFileSync(join(tmpDir, "package.json"), "{}");
  writeFileSync(join(tmpDir, "README.md"), "");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("buildRootNodes", () => {
  it("returns dirs first, then files, alphabetically", () => {
    const ig = ignore();
    const nodes = buildRootNodes(tmpDir, tmpDir, ig, new Map(), false);
    const names = nodes.map((n) => n.entry.name);
    assert.deepStrictEqual(names, ["docs", "src", "package.json", "README.md"]);
  });

  it("sets depth to 0 for all root nodes", () => {
    const ig = ignore();
    const nodes = buildRootNodes(tmpDir, tmpDir, ig, new Map(), false);
    assert.ok(nodes.every((n) => n.depth === 0));
  });

  it("attaches git status from map", () => {
    const ig = ignore();
    const gitMap = new Map([["package.json", "M"]]);
    const nodes = buildRootNodes(tmpDir, tmpDir, ig, gitMap, false);
    const pkg = nodes.find((n) => n.entry.name === "package.json");
    assert.strictEqual(pkg?.gitStatus, "M");
  });

  it("sets gitStatus to null when not in map", () => {
    const ig = ignore();
    const nodes = buildRootNodes(tmpDir, tmpDir, ig, new Map(), false);
    assert.ok(nodes.every((n) => n.gitStatus === null));
  });

  it("filters hidden files when showHidden is false", () => {
    writeFileSync(join(tmpDir, ".hidden"), "");
    const ig = ignore();
    const nodes = buildRootNodes(tmpDir, tmpDir, ig, new Map(), false);
    assert.ok(!nodes.some((n) => n.entry.name === ".hidden"));
  });

  it("includes hidden files when showHidden is true", () => {
    writeFileSync(join(tmpDir, ".hidden"), "");
    const ig = ignore();
    const nodes = buildRootNodes(tmpDir, tmpDir, ig, new Map(), true);
    assert.ok(nodes.some((n) => n.entry.name === ".hidden"));
  });

  it("uses projectRoot for relative paths when scanning a subdirectory", () => {
    const ig = ignore();
    const nodes = buildRootNodes(join(tmpDir, "src"), tmpDir, ig, new Map(), false);
    const indexNode = nodes.find((n) => n.entry.name === "index.ts");
    assert.ok(indexNode);
    assert.strictEqual(indexNode.entry.path, "src/index.ts");
  });
});

describe("expandNode", () => {
  it("populates children with correct depth", () => {
    const ig = ignore();
    const nodes = buildRootNodes(tmpDir, tmpDir, ig, new Map(), false);
    const src = nodes.find((n) => n.entry.name === "src")!;
    expandNode(src, tmpDir, ig, new Map(), false);
    assert.strictEqual(src.expanded, true);
    assert.ok(src.children.length > 0);
    assert.ok(src.children.every((c) => c.depth === 1));
  });

  it("does not expand files", () => {
    const ig = ignore();
    const nodes = buildRootNodes(tmpDir, tmpDir, ig, new Map(), false);
    const pkg = nodes.find((n) => n.entry.name === "package.json")!;
    expandNode(pkg, tmpDir, ig, new Map(), false);
    assert.strictEqual(pkg.expanded, false);
    assert.strictEqual(pkg.children.length, 0);
  });

  it("does not re-expand already expanded node", () => {
    const ig = ignore();
    const nodes = buildRootNodes(tmpDir, tmpDir, ig, new Map(), false);
    const src = nodes.find((n) => n.entry.name === "src")!;
    expandNode(src, tmpDir, ig, new Map(), false);
    const originalChildren = src.children;
    expandNode(src, tmpDir, ig, new Map(), false);
    assert.strictEqual(src.children, originalChildren);
  });

  it("shows nested children with incremented depth", () => {
    const ig = ignore();
    const nodes = buildRootNodes(tmpDir, tmpDir, ig, new Map(), false);
    const src = nodes.find((n) => n.entry.name === "src")!;
    expandNode(src, tmpDir, ig, new Map(), false);
    const lib = src.children.find((c) => c.entry.name === "lib")!;
    expandNode(lib, tmpDir, ig, new Map(), false);
    assert.ok(lib.children.every((c) => c.depth === 2));
  });
});

describe("collapseNode", () => {
  it("clears children and sets expanded to false", () => {
    const ig = ignore();
    const nodes = buildRootNodes(tmpDir, tmpDir, ig, new Map(), false);
    const src = nodes.find((n) => n.entry.name === "src")!;
    expandNode(src, tmpDir, ig, new Map(), false);
    assert.ok(src.children.length > 0);
    collapseNode(src);
    assert.strictEqual(src.expanded, false);
    assert.strictEqual(src.children.length, 0);
  });
});

describe("flattenVisibleNodes", () => {
  it("returns only root nodes when nothing is expanded", () => {
    const ig = ignore();
    const nodes = buildRootNodes(tmpDir, tmpDir, ig, new Map(), false);
    const flat = flattenVisibleNodes(nodes);
    assert.strictEqual(flat.length, nodes.length);
  });

  it("includes children of expanded nodes", () => {
    const ig = ignore();
    const nodes = buildRootNodes(tmpDir, tmpDir, ig, new Map(), false);
    const src = nodes.find((n) => n.entry.name === "src")!;
    expandNode(src, tmpDir, ig, new Map(), false);
    const flat = flattenVisibleNodes(nodes);
    assert.ok(flat.length > nodes.length);
    const srcIdx = flat.indexOf(src);
    assert.ok(srcIdx >= 0);
    assert.strictEqual(flat[srcIdx + 1]?.depth, 1);
  });

  it("returns correct depth-first order with nested expansion", () => {
    const ig = ignore();
    const nodes = buildRootNodes(tmpDir, tmpDir, ig, new Map(), false);
    const src = nodes.find((n) => n.entry.name === "src")!;
    expandNode(src, tmpDir, ig, new Map(), false);
    const lib = src.children.find((c) => c.entry.name === "lib")!;
    expandNode(lib, tmpDir, ig, new Map(), false);
    const flat = flattenVisibleNodes(nodes);
    const names = flat.map((n) => n.entry.name);
    const srcIdx = names.indexOf("src");
    const libIdx = names.indexOf("lib");
    const utilsIdx = names.indexOf("utils.ts");
    assert.ok(srcIdx < libIdx);
    assert.ok(libIdx < utilsIdx);
  });
});

describe("refreshExpandedNodes", () => {
  it("picks up new files in expanded directories", () => {
    const ig = ignore();
    const nodes = buildRootNodes(tmpDir, tmpDir, ig, new Map(), false);
    const src = nodes.find((n) => n.entry.name === "src")!;
    expandNode(src, tmpDir, ig, new Map(), false);
    const countBefore = src.children.length;

    writeFileSync(join(tmpDir, "src", "new-file.ts"), "");

    const refreshed = refreshExpandedNodes(nodes, tmpDir, ig, new Map(), false);
    const refreshedSrc = refreshed.find((n) => n.entry.name === "src")!;
    assert.ok(refreshedSrc.expanded);
    assert.ok(refreshedSrc.children.length > countBefore);
    assert.ok(refreshedSrc.children.some((c) => c.entry.name === "new-file.ts"));
  });

  it("preserves expanded state of nested directories", () => {
    const ig = ignore();
    const nodes = buildRootNodes(tmpDir, tmpDir, ig, new Map(), false);
    const src = nodes.find((n) => n.entry.name === "src")!;
    expandNode(src, tmpDir, ig, new Map(), false);
    const lib = src.children.find((c) => c.entry.name === "lib")!;
    expandNode(lib, tmpDir, ig, new Map(), false);

    const refreshed = refreshExpandedNodes(nodes, tmpDir, ig, new Map(), false);
    const refreshedSrc = refreshed.find((n) => n.entry.name === "src")!;
    const refreshedLib = refreshedSrc.children.find((c) => c.entry.name === "lib")!;
    assert.strictEqual(refreshedLib.expanded, true);
    assert.ok(refreshedLib.children.length > 0);
  });

  it("updates git status on refresh", () => {
    const ig = ignore();
    const gitMap = new Map([["package.json", "M"]]);
    const nodes = buildRootNodes(tmpDir, tmpDir, ig, new Map(), false);

    const refreshed = refreshExpandedNodes(nodes, tmpDir, ig, gitMap, false);
    const pkg = refreshed.find((n) => n.entry.name === "package.json");
    assert.strictEqual(pkg?.gitStatus, "M");
  });
});
