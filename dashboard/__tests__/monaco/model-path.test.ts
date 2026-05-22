/**
 * Monaco URI helpers — pure-function tests. No Monaco runtime needed.
 */

import { describe, expect, it } from "vitest";
import { buildMonacoModelPath, toDiskUri, toGitUri } from "@/lib/monaco/model-path";

describe("buildMonacoModelPath", () => {
  it("builds an absolute file:// URI from root + relative file", () => {
    expect(buildMonacoModelPath("/Users/me/proj", "src/index.ts")).toBe(
      "file:///Users/me/proj/src/index.ts",
    );
  });

  it("normalises Windows-style separators + trailing slashes", () => {
    expect(buildMonacoModelPath("C:\\Users\\me\\proj\\", "src\\app.tsx")).toBe(
      "file:///C%3A/Users/me/proj/src/app.tsx",
    );
  });

  it("percent-encodes spaces and special chars per segment", () => {
    expect(buildMonacoModelPath("/repo", "src/My File.ts")).toBe("file:///repo/src/My%20File.ts");
  });

  it("collapses double slashes", () => {
    expect(buildMonacoModelPath("/repo/", "/src/x.ts")).toBe("file:///repo/src/x.ts");
  });
});

describe("toDiskUri / toGitUri", () => {
  it("swaps file:// → disk:// preserving the body", () => {
    expect(toDiskUri("file:///repo/src/x.ts")).toBe("disk:///repo/src/x.ts");
  });

  it("appends a percent-encoded ref to the git URI", () => {
    expect(toGitUri("file:///repo/src/x.ts", "origin/main")).toBe(
      "git://repo/src/x.ts/origin%2Fmain",
    );
  });
});
