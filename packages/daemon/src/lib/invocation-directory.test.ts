import { describe, expect, it } from "vitest";

import { invocationDirectory } from "./invocation-directory.ts";

describe("invocationDirectory (#585)", () => {
  it("is the current directory while it exists", () => {
    expect(invocationDirectory({ cwd: () => "/work/project", home: () => "/Users/someone" })).toBe(
      "/work/project",
    );
  });

  it("is the home directory when the current directory was deleted", () => {
    const deleted = () => {
      throw Object.assign(new Error("ENOENT: process.cwd failed, uv_cwd"), { code: "ENOENT" });
    };
    expect(invocationDirectory({ cwd: deleted, home: () => "/Users/someone" })).toBe(
      "/Users/someone",
    );
  });

  it("does not hide another failure", () => {
    const denied = () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    };
    expect(() => invocationDirectory({ cwd: denied, home: () => "/Users/someone" })).toThrow(
      "EACCES",
    );
  });
});
