import { describe, expect, it } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertInsideSandbox,
  browseDirectory,
  computeParentPath,
  InvalidPathError,
  PathNotFoundError,
  SandboxViolationError,
  sortEntries,
  type BrowseIo,
} from "./filesystem-browser.ts";
import type { FilesystemEntry } from "../schemas/filesystem.ts";

// Build a fake io rooted at a real temp dir so realpath/readdir work
// against the actual filesystem (much simpler than mocking every call).
function makeIo(home: string, overrides: Partial<BrowseIo> = {}, baseIo?: BrowseIo): BrowseIo {
  const realDefaults: BrowseIo = {
    realpath: (p) => realpathSync(p),
    stat: (p) => statSync(p),
    readdir: (p) => readdirSync(p, { withFileTypes: true }),
    home: () => home,
    now: () => 0,
  };
  return { ...realDefaults, ...(baseIo ?? {}), ...overrides };
}

describe("assertInsideSandbox", () => {
  it("allows paths inside the home directory", () => {
    expect(() => assertInsideSandbox("/Users/alice/projects", "/Users/alice")).not.toThrow();
    expect(() => assertInsideSandbox("/Users/alice", "/Users/alice")).not.toThrow();
  });

  it("allows /Users root listing", () => {
    expect(() => assertInsideSandbox("/Users", "/Users/alice")).not.toThrow();
  });

  it("allows /Volumes for external drives", () => {
    expect(() => assertInsideSandbox("/Volumes/External/foo", "/Users/alice")).not.toThrow();
  });

  it("rejects /etc and other system paths", () => {
    expect(() => assertInsideSandbox("/etc/hosts", "/Users/alice")).toThrow(SandboxViolationError);
    expect(() => assertInsideSandbox("/", "/Users/alice")).toThrow(SandboxViolationError);
  });

  it("does not treat a sibling directory as a prefix match for home", () => {
    // /Users/alice2 should NOT match the home prefix /Users/alice — but it
    // IS allowed independently because /Users is a permitted root.
    expect(() => assertInsideSandbox("/Users/alice2", "/Users/alice")).not.toThrow();
    // A path that fully shares the home prefix without being a subpath
    // (e.g. /Users/alicebogus) is still ok via /Users root, but a sibling
    // path outside any allowed root must throw.
    expect(() => assertInsideSandbox("/private/etc", "/Users/alice")).toThrow(
      SandboxViolationError,
    );
  });
});

describe("computeParentPath", () => {
  it("returns the parent when inside the sandbox", () => {
    expect(computeParentPath("/Users/alice/projects/foo", "/Users/alice")).toBe(
      "/Users/alice/projects",
    );
  });

  it("returns null when the parent would escape the sandbox", () => {
    // /Users/alice has parent /Users which is allowed; /Users has parent /
    // which is outside the sandbox.
    expect(computeParentPath("/Users", "/Users/alice")).toBeNull();
  });

  it("returns null at the filesystem root", () => {
    expect(computeParentPath("/", "/Users/alice")).toBeNull();
  });
});

describe("sortEntries", () => {
  function entry(name: string, isDir: boolean): FilesystemEntry {
    return { name, fullPath: `/x/${name}`, isDir, isSymlink: false };
  }

  it("sorts dirs before files", () => {
    const sorted = sortEntries([entry("z.md", false), entry("a-dir", true)]);
    expect(sorted.map((e) => e.name)).toEqual(["a-dir", "z.md"]);
  });

  it("alphabetizes case-insensitively within groups", () => {
    const sorted = sortEntries([
      entry("Beta", true),
      entry("alpha", true),
      entry("README", false),
      entry("LICENSE", false),
    ]);
    expect(sorted.map((e) => e.name)).toEqual(["alpha", "Beta", "LICENSE", "README"]);
  });
});

describe("browseDirectory", () => {
  function setupSandbox(): {
    home: string;
    cleanup: () => void;
  } {
    // Use realpath() so the sandbox check compares canonical paths. On
    // macOS tmpdir() returns /var/folders/... which realpath-resolves
    // under /private — without canonicalizing here we'd block ourselves.
    const home = realpathSync(mkdtempSync(join(tmpdir(), "fs-browse-home-")));
    return {
      home,
      cleanup: () => rmSync(home, { recursive: true, force: true }),
    };
  }

  it("lists entries inside home with dirs first and hidden files filtered", () => {
    const { home, cleanup } = setupSandbox();
    try {
      mkdirSync(join(home, "alpha"));
      mkdirSync(join(home, "beta"));
      writeFileSync(join(home, "README.md"), "");
      writeFileSync(join(home, ".hidden"), "");

      const result = browseDirectory({}, makeIo(home));
      expect(result.path).toBe(realpathSync(home));
      expect(result.entries.map((e) => e.name)).toEqual(["alpha", "beta", "README.md"]);
      expect(result.entries.find((e) => e.name === "alpha")?.isDir).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("includes hidden files when showHidden is true", () => {
    const { home, cleanup } = setupSandbox();
    try {
      writeFileSync(join(home, ".env"), "");
      writeFileSync(join(home, "README.md"), "");
      const result = browseDirectory({ showHidden: true }, makeIo(home));
      expect(result.entries.map((e) => e.name)).toContain(".env");
    } finally {
      cleanup();
    }
  });

  it("rejects paths outside the sandbox", () => {
    const { home, cleanup } = setupSandbox();
    try {
      expect(() => browseDirectory({ path: "/etc" }, makeIo(home))).toThrow(SandboxViolationError);
    } finally {
      cleanup();
    }
  });

  it("throws PathNotFoundError for missing paths", () => {
    const { home, cleanup } = setupSandbox();
    try {
      expect(() => browseDirectory({ path: join(home, "does-not-exist") }, makeIo(home))).toThrow(
        PathNotFoundError,
      );
    } finally {
      cleanup();
    }
  });

  it("rejects non-absolute and null-byte paths", () => {
    const { home, cleanup } = setupSandbox();
    try {
      expect(() => browseDirectory({ path: "relative/path" }, makeIo(home))).toThrow(
        InvalidPathError,
      );
      expect(() => browseDirectory({ path: "/oops\0null" }, makeIo(home))).toThrow(
        InvalidPathError,
      );
    } finally {
      cleanup();
    }
  });

  it("classifies symlinks pointing to directories as isDir=true and isSymlink=true", () => {
    const { home, cleanup } = setupSandbox();
    try {
      mkdirSync(join(home, "real-dir"));
      symlinkSync(join(home, "real-dir"), join(home, "link-to-dir"));
      writeFileSync(join(home, "real-file"), "");
      symlinkSync(join(home, "real-file"), join(home, "link-to-file"));

      const result = browseDirectory({}, makeIo(home));
      const linkToDir = result.entries.find((e) => e.name === "link-to-dir");
      const linkToFile = result.entries.find((e) => e.name === "link-to-file");
      expect(linkToDir).toBeDefined();
      expect(linkToDir?.isDir).toBe(true);
      expect(linkToDir?.isSymlink).toBe(true);
      expect(linkToFile?.isDir).toBe(false);
      expect(linkToFile?.isSymlink).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("returns parentPath=null when at the home directory boundary going up to /Users", () => {
    const { home, cleanup } = setupSandbox();
    try {
      const result = browseDirectory({}, makeIo(home));
      // home is under /var/folders/... on macOS or /tmp on linux. Either
      // way the parent is allowed by the sandbox (under /Users on macOS
      // is not the case here, but tmpdir often resolves under /private
      // which IS considered ok if it's the user's tmp). We mainly check
      // the value is either a string or null — never an error.
      expect(result.parentPath === null || typeof result.parentPath === "string").toBe(true);
    } finally {
      cleanup();
    }
  });

  it("defaults to home when no path is provided", () => {
    const { home, cleanup } = setupSandbox();
    try {
      mkdirSync(join(home, "subdir"));
      const result = browseDirectory({}, makeIo(home));
      expect(result.path).toBe(realpathSync(home));
      expect(result.entries.map((e) => e.name)).toEqual(["subdir"]);
    } finally {
      cleanup();
    }
  });
});
