import { describe, expect, it } from "vitest";
import {
  ancestorDirs,
  buildNodes,
  changedFileWalk,
  filterEntries,
  filterView,
  indexOfPath,
  insertChildrenAt,
  nextChangedPath,
  rebuildTree,
  relPath,
  removeSubtreeAt,
  sortEntries,
  statusMapFromEntries,
  treePathCompare,
  type FileNode,
  type RawEntry,
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
      { name: "a.ts", path: "/root/a.ts", isDir: false, depth: 0, expanded: false, ignored: false },
    ]);
  });

  it("carries the ignored flag through to the node", () => {
    const nodes = buildNodes("/r", [{ name: "gen.ts", isDir: false, ignored: true }], 1);
    expect(nodes[0]!.ignored).toBe(true);
    expect(nodes[0]!.depth).toBe(1);
  });
});

describe("filterEntries", () => {
  const entries: RawEntry[] = [
    { name: "node_modules", isDir: true },
    { name: ".git", isDir: true },
    { name: ".env", isDir: false },
    { name: "gen", isDir: true, ignored: true },
    { name: "out.log", isDir: false, ignored: true },
    { name: "src", isDir: true },
    { name: "main.ts", isDir: false },
  ];

  it("defaults hide ALWAYS_IGNORE, dotfiles, and gitignored entries", () => {
    const out = filterEntries(entries, { showHidden: false, showIgnored: false });
    expect(out.map((e) => e.name)).toEqual(["src", "main.ts"]);
  });

  it("H shows dotfiles but never ALWAYS_IGNORE names", () => {
    const out = filterEntries(entries, { showHidden: true, showIgnored: false });
    expect(out.map((e) => e.name)).toEqual([".env", "src", "main.ts"]);
  });

  it("I shows gitignored entries", () => {
    const out = filterEntries(entries, { showHidden: false, showIgnored: true });
    expect(out.map((e) => e.name)).toEqual(["gen", "out.log", "src", "main.ts"]);
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

describe("relPath / ancestorDirs", () => {
  it("strips the root prefix, tolerating a trailing slash", () => {
    expect(relPath("/w", "/w/a/b.ts")).toBe("a/b.ts");
    expect(relPath("/w/", "/w/a/b.ts")).toBe("a/b.ts");
    expect(relPath("/w", "/w")).toBe("");
    expect(relPath("/w", "/wider/x")).toBe(""); // not under root
  });

  it("lists ancestor dirs outermost first", () => {
    expect(ancestorDirs("a/b/c.ts")).toEqual(["a", "a/b"]);
    expect(ancestorDirs("top.ts")).toEqual([]);
  });
});

describe("statusMapFromEntries", () => {
  it("maps files and propagates the first-seen status to ancestor dirs", () => {
    const map = statusMapFromEntries([
      { path: "src/deep/a.ts", status: "M" },
      { path: "src/b.ts", status: "A" },
      { path: "top.ts", status: "?" },
    ]);
    expect(map.get("src/deep/a.ts")).toBe("M");
    expect(map.get("src/deep")).toBe("M");
    expect(map.get("src")).toBe("M"); // first child wins, not overwritten by A
    expect(map.get("src/b.ts")).toBe("A");
    expect(map.get("top.ts")).toBe("?");
    expect(map.has("")).toBe(false);
  });
});

describe("treePathCompare", () => {
  it("orders like the rendered tree: dirs before files, case-insensitive", () => {
    const paths = ["z.ts", "a/x.ts", "B.ts", "a/deep/y.ts", "a/a.ts"];
    paths.sort(treePathCompare);
    expect(paths).toEqual(["a/deep/y.ts", "a/a.ts", "a/x.ts", "B.ts", "z.ts"]);
  });

  it("a dir component beats a file segment even when named later", () => {
    expect(treePathCompare("zebra/x.ts", "apple.ts")).toBeLessThan(0);
  });
});

describe("changedFileWalk", () => {
  it("dedupes, drops ALWAYS_IGNORE segments and deletions, sorts in tree order", () => {
    const walk = changedFileWalk(
      [
        { path: "src/b.ts" },
        { path: "a.ts" },
        { path: "src/b.ts" },
        { path: "node_modules/x/y.js" },
        { path: "vendor/lib.go" },
        // a deleted file has no tree row — hopping onto it would wedge `]`
        { path: "gone.ts", status: "D" },
      ],
      { showHidden: true },
    );
    expect(walk).toEqual(["src/b.ts", "a.ts"]);
  });

  it("drops dot segments while hidden files are off, keeps them when on", () => {
    const entries = [{ path: ".config/app.json" }, { path: "src/.env" }, { path: "src/ok.ts" }];
    expect(changedFileWalk(entries, { showHidden: false })).toEqual(["src/ok.ts"]);
    expect(changedFileWalk(entries, { showHidden: true })).toEqual([
      ".config/app.json",
      "src/.env",
      "src/ok.ts",
    ]);
  });
});

describe("nextChangedPath", () => {
  const walk = ["a/deep/y.ts", "a/x.ts", "m.ts", "z.ts"];

  it("steps forward and backward with wraparound", () => {
    expect(nextChangedPath(walk, "a/x.ts", 1)).toBe("m.ts");
    expect(nextChangedPath(walk, "z.ts", 1)).toBe("a/deep/y.ts"); // wrap
    expect(nextChangedPath(walk, "m.ts", -1)).toBe("a/x.ts");
    expect(nextChangedPath(walk, "a/deep/y.ts", -1)).toBe("z.ts"); // wrap
  });

  it("lands on the nearest entry when current is not in the walk", () => {
    expect(nextChangedPath(walk, "b.ts", 1)).toBe("m.ts");
    expect(nextChangedPath(walk, "b.ts", -1)).toBe("a/x.ts");
  });

  it("handles a null current and an empty walk", () => {
    expect(nextChangedPath(walk, null, 1)).toBe("a/deep/y.ts");
    expect(nextChangedPath(walk, null, -1)).toBe("z.ts");
    expect(nextChangedPath([], "x", 1)).toBeNull();
  });
});

describe("filterView", () => {
  const list = buildNodes(
    "/r",
    [
      { name: "src", isDir: true },
      { name: "main.ts", isDir: false },
      { name: "Makefile", isDir: false },
    ],
    0,
  );

  it("null or empty query returns every row with its own index", () => {
    expect(filterView(list, null).map((r) => r.index)).toEqual([0, 1, 2]);
    expect(filterView(list, "").length).toBe(3);
  });

  it("narrows by case-insensitive name containment, keeping underlying indices", () => {
    const rows = filterView(list, "MA");
    expect(rows.map((r) => r.node.name)).toEqual(["main.ts", "Makefile"]);
    expect(rows.map((r) => r.index)).toEqual([1, 2]);
  });
});

describe("indexOfPath", () => {
  it("finds a row by absolute path", () => {
    const list = buildNodes("/r", [{ name: "a.ts", isDir: false }], 0);
    expect(indexOfPath(list, "/r/a.ts")).toBe(0);
    expect(indexOfPath(list, "/r/missing")).toBe(-1);
  });
});

describe("rebuildTree", () => {
  it("rebuilds from fresh listings, preserving expansion", () => {
    const listing = new Map<string, RawEntry[]>([
      [
        "/r",
        [
          { name: "dir", isDir: true },
          { name: "z.ts", isDir: false },
        ],
      ],
      [
        "/r/dir",
        [
          { name: "sub", isDir: true },
          { name: "new.ts", isDir: false },
        ],
      ],
      ["/r/dir/sub", [{ name: "deep.ts", isDir: false }]],
    ]);
    const out = rebuildTree("/r", listing, new Set(["/r/dir", "/r/dir/sub"]));
    expect(out.map((n) => `${n.depth}:${n.name}`)).toEqual([
      "0:dir",
      "1:sub",
      "2:deep.ts",
      "1:new.ts",
      "0:z.ts",
    ]);
    expect(out[0]!.expanded).toBe(true);
    expect(out[1]!.expanded).toBe(true);
  });

  it("collapses a dir whose fresh listing was not provided and drops vanished dirs", () => {
    const listing = new Map<string, RawEntry[]>([["/r", [{ name: "dir", isDir: true }]]]);
    const out = rebuildTree("/r", listing, new Set(["/r/dir", "/r/gone"]));
    expect(out.map((n) => n.name)).toEqual(["dir"]);
    expect(out[0]!.expanded).toBe(false);
  });
});
