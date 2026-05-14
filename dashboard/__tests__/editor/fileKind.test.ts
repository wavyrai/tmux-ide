/**
 * `getFileKind` — pure-function tests, no runtime deps.
 *
 * Locks the extension → kind table so the dispatch in
 * `FileRenderer` keeps routing correctly across silo / daemon
 * changes.
 */

import { describe, expect, it } from "vitest";
import { getFileKind, isPreviewableKind, isBinaryForDiff } from "@/lib/editor/fileKind";

describe("getFileKind", () => {
  it("routes raster images to 'image'", () => {
    for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "ico", "bmp"]) {
      expect(getFileKind(`avatar.${ext}`)).toBe("image");
    }
  });

  it("routes .svg to 'svg', not 'image'", () => {
    expect(getFileKind("logo.svg")).toBe("svg");
  });

  it("routes markdown extensions to 'markdown'", () => {
    expect(getFileKind("README.md")).toBe("markdown");
    expect(getFileKind("docs/intro.mdx")).toBe("markdown");
  });

  it("routes known binary extensions to 'binary'", () => {
    for (const ext of ["wasm", "zip", "pdf", "ttf", "mp4", "sqlite3"]) {
      expect(getFileKind(`blob.${ext}`)).toBe("binary");
    }
  });

  it("falls through to 'text' for unknown / source extensions", () => {
    for (const path of [
      "src/index.ts",
      "src/app.tsx",
      "build.gradle",
      "Cargo.toml",
      "Makefile",
      "no-extension",
    ]) {
      expect(getFileKind(path)).toBe("text");
    }
  });

  it("is case-insensitive on the extension", () => {
    expect(getFileKind("README.MD")).toBe("markdown");
    expect(getFileKind("LOGO.SVG")).toBe("svg");
    expect(getFileKind("blob.ZIP")).toBe("binary");
  });
});

describe("isPreviewableKind", () => {
  it("is true for svg + markdown", () => {
    expect(isPreviewableKind("svg")).toBe(true);
    expect(isPreviewableKind("markdown")).toBe(true);
  });

  it("is false for everything else", () => {
    expect(isPreviewableKind("text")).toBe(false);
    expect(isPreviewableKind("image")).toBe(false);
    expect(isPreviewableKind("binary")).toBe(false);
    expect(isPreviewableKind("too-large")).toBe(false);
  });
});

describe("isBinaryForDiff", () => {
  it("returns true for both binary + image kinds", () => {
    expect(isBinaryForDiff("blob.zip")).toBe(true);
    expect(isBinaryForDiff("avatar.png")).toBe(true);
  });

  it("returns false for diffable kinds (text, markdown, svg)", () => {
    expect(isBinaryForDiff("src/x.ts")).toBe(false);
    expect(isBinaryForDiff("README.md")).toBe(false);
    expect(isBinaryForDiff("logo.svg")).toBe(false);
  });
});
