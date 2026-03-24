import { describe, it, beforeEach, afterEach, expect } from "bun:test";
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
    expect(names).toEqual(["docs", "src", "package.json", "README.md"]);
  });

  it("sets depth to 0 for all root nodes", () => {
    const ig = ignore();
    const nodes = buildRootNodes(tmpDir, tmpDir, ig, new Map(), false);
    expect(nodes.every((n) => n.depth === 0)).toBeTruthy();
  });

  it("attaches git status from map", () => {
    const ig = ignore();
    const gitMap = new Map([["package.json", "M"]]);
    const nodes = buildRootNodes(tmpDir, tmpDir, ig, gitMap, false);
    const pkg = nodes.find((n) => n.entry.name === "package.json");
    expect(pkg?.gitStatus).toBe("M");
  });

  it("sets gitStatus to null when not in map", () => {
    const ig = ignore();
    const nodes = buildRootNodes(tmpDir, tmpDir, ig, new Map(), false);
    expect(nodes.every((n) => n.gitStatus === null)).toBeTruthy();
  });

  it("filters hidden files when showHidden is false", () => {
    writeFileSync(join(tmpDir, ".hidden"), "");
    const ig = ignore();
    const nodes = buildRootNodes(tmpDir, tmpDir, ig, new Map(), false);
    expect(!nodes.some((n) => n.entry.name === ".hidden")).toBeTruthy();
  });

  it("includes hidden files when showHidden is true", () => {
    writeFileSync(join(tmpDir, ".hidden"), "");
    const ig = ignore();
    const nodes = buildRootNodes(tmpDir, tmpDir, ig, new Map(), true);
    expect(nodes.some((n) => n.entry.name === ".hidden")).toBeTruthy();
  });

  it("uses projectRoot for relative paths when scanning a subdirectory", () => {
    const ig = ignore();
    const nodes = buildRootNodes(join(tmpDir, "src"), tmpDir, ig, new Map(), false);
    const indexNode = nodes.find((n) => n.entry.name === "index.ts");
    expect(indexNode).toBeTruthy();
    expect(indexNode.entry.path).toBe("src/index.ts");
  });
});

describe("expandNode", () => {
  it("populates children with correct depth", () => {
    const ig = ignore();
    const nodes = buildRootNodes(tmpDir, tmpDir, ig, new Map(), false);
    const src = nodes.find((n) => n.entry.name === "src")!;
    expandNode(src, tmpDir, ig, new Map(), false);
    expect(src.expanded).toBe(true);
    expect(src.children.length > 0).toBeTruthy();
    expect(src.children.every((c) => c.depth === 1)).toBeTruthy();
  });

  it("does not expand files", () => {
    const ig = ignore();
    const nodes = buildRootNodes(tmpDir, tmpDir, ig, new Map(), false);
    const pkg = nodes.find((n) => n.entry.name === "package.json")!;
    expandNode(pkg, tmpDir, ig, new Map(), false);
    expect(pkg.expanded).toBe(false);
    expect(pkg.children.length).toBe(0);
  });

  it("does not re-expand already expanded node", () => {
    const ig = ignore();
    const nodes = buildRootNodes(tmpDir, tmpDir, ig, new Map(), false);
    const src = nodes.find((n) => n.entry.name === "src")!;
    expandNode(src, tmpDir, ig, new Map(), false);
    const originalChildren = src.children;
    expandNode(src, tmpDir, ig, new Map(), false);
    expect(src.children).toBe(originalChildren);
  });

  it("shows nested children with incremented depth", () => {
    const ig = ignore();
    const nodes = buildRootNodes(tmpDir, tmpDir, ig, new Map(), false);
    const src = nodes.find((n) => n.entry.name === "src")!;
    expandNode(src, tmpDir, ig, new Map(), false);
    const lib = src.children.find((c) => c.entry.name === "lib")!;
    expandNode(lib, tmpDir, ig, new Map(), false);
    expect(lib.children.every((c) => c.depth === 2)).toBeTruthy();
  });
});

describe("collapseNode", () => {
  it("clears children and sets expanded to false", () => {
    const ig = ignore();
    const nodes = buildRootNodes(tmpDir, tmpDir, ig, new Map(), false);
    const src = nodes.find((n) => n.entry.name === "src")!;
    expandNode(src, tmpDir, ig, new Map(), false);
    expect(src.children.length > 0).toBeTruthy();
    collapseNode(src);
    expect(src.expanded).toBe(false);
    expect(src.children.length).toBe(0);
  });
});

describe("flattenVisibleNodes", () => {
  it("returns only root nodes when nothing is expanded", () => {
    const ig = ignore();
    const nodes = buildRootNodes(tmpDir, tmpDir, ig, new Map(), false);
    const flat = flattenVisibleNodes(nodes);
    expect(flat.length).toBe(nodes.length);
  });

  it("includes children of expanded nodes", () => {
    const ig = ignore();
    const nodes = buildRootNodes(tmpDir, tmpDir, ig, new Map(), false);
    const src = nodes.find((n) => n.entry.name === "src")!;
    expandNode(src, tmpDir, ig, new Map(), false);
    const flat = flattenVisibleNodes(nodes);
    expect(flat.length > nodes.length).toBeTruthy();
    const srcIdx = flat.indexOf(src);
    expect(srcIdx >= 0).toBeTruthy();
    expect(flat[srcIdx + 1]?.depth).toBe(1);
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
    expect(srcIdx < libIdx).toBeTruthy();
    expect(libIdx < utilsIdx).toBeTruthy();
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
    expect(refreshedSrc.expanded).toBeTruthy();
    expect(refreshedSrc.children.length > countBefore).toBeTruthy();
    expect(refreshedSrc.children.some((c) => c.entry.name === "new-file.ts")).toBeTruthy();
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
    expect(refreshedLib.expanded).toBe(true);
    expect(refreshedLib.children.length > 0).toBeTruthy();
  });

  it("updates git status on refresh", () => {
    const ig = ignore();
    const gitMap = new Map([["package.json", "M"]]);
    const nodes = buildRootNodes(tmpDir, tmpDir, ig, new Map(), false);

    const refreshed = refreshExpandedNodes(nodes, tmpDir, ig, gitMap, false);
    const pkg = refreshed.find((n) => n.entry.name === "package.json");
    expect(pkg?.gitStatus).toBe("M");
  });
});
