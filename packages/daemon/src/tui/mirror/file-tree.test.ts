import { describe, expect, it } from "vitest";
import {
  buildNodes,
  insertChildrenAt,
  removeSubtreeAt,
  sortEntries,
  type FileNode,
} from "./file-tree.ts";

describe("sortEntries", () => {
  it("puts directories before files, each group case-insensitive alpha", () => {
    const sorted = sortEntries([
      { name: "readme.md", isDir: false },
      { name: "Zed", isDir: true },
      { name: "app.ts", isDir: false },
      { name: "assets", isDir: true },
    ]);
    expect(sorted.map((e) => e.name)).toEqual(["assets", "Zed", "app.ts", "readme.md"]);
  });
});

describe("buildNodes", () => {
  it("joins names onto the dir and tags depth, tolerating a trailing slash", () => {
    const nodes = buildNodes("/root/", [{ name: "a.ts", isDir: false }], 0);
    expect(nodes).toEqual([
      { name: "a.ts", path: "/root/a.ts", isDir: false, depth: 0, expanded: false },
    ]);
  });
});

describe("insertChildrenAt / removeSubtreeAt", () => {
  const root = (): FileNode[] =>
    buildNodes(
      "/r",
      [
        { name: "dir", isDir: true },
        { name: "z.ts", isDir: false },
      ],
      0,
    );

  it("expands a directory by splicing children right after it", () => {
    const children = buildNodes("/r/dir", [{ name: "inner.ts", isDir: false }], 1);
    const out = insertChildrenAt(root(), 0, children);
    expect(out.map((n) => n.name)).toEqual(["dir", "inner.ts", "z.ts"]);
    expect(out[0]!.expanded).toBe(true);
  });

  it("is a no-op on a file, a missing row, or an already-expanded dir", () => {
    const list = root();
    expect(insertChildrenAt(list, 1, [])).toBe(list); // z.ts is a file
    expect(insertChildrenAt(list, 9, [])).toBe(list); // out of range
    const expanded = insertChildrenAt(list, 0, buildNodes("/r/dir", [], 1));
    expect(insertChildrenAt(expanded, 0, [])).toBe(expanded); // already expanded
  });

  it("collapses the whole subtree, however deep it was expanded", () => {
    let out = insertChildrenAt(root(), 0, buildNodes("/r/dir", [{ name: "sub", isDir: true }], 1));
    // expand the nested dir too (depth 2)
    out = insertChildrenAt(
      out,
      1,
      buildNodes("/r/dir/sub", [{ name: "deep.ts", isDir: false }], 2),
    );
    expect(out.map((n) => n.name)).toEqual(["dir", "sub", "deep.ts", "z.ts"]);
    const collapsed = removeSubtreeAt(out, 0);
    expect(collapsed.map((n) => n.name)).toEqual(["dir", "z.ts"]);
    expect(collapsed[0]!.expanded).toBe(false);
  });
});
