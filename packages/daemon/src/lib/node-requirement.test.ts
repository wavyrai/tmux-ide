import { describe, expect, it } from "vitest";
import {
  MINIMUM_NODE_MAJOR,
  isSupportedNodeVersion,
  unsupportedNodeMessage,
} from "./node-requirement.ts";

describe("Node.js requirement", () => {
  it("requires Node 24", () => {
    expect(MINIMUM_NODE_MAJOR).toBe(24);
    expect(isSupportedNodeVersion("20.20.2")).toBe(false);
    expect(isSupportedNodeVersion("22.23.1")).toBe(false);
    expect(isSupportedNodeVersion("24.0.0")).toBe(true);
    expect(isSupportedNodeVersion("25.1.0")).toBe(true);
    expect(isSupportedNodeVersion("garbage")).toBe(false);
  });

  it("names Node 24 and the running version when the runtime is too old", () => {
    const message = unsupportedNodeMessage({ node: "22.23.1" });
    expect(message).toContain("Node.js 24 or newer");
    expect(message).toContain("this is Node.js 22.23.1");
    expect(message).toContain("install.sh");
  });

  it("stays silent on a supported Node and under Bun", () => {
    expect(unsupportedNodeMessage({ node: "24.11.1" })).toBeNull();
    expect(unsupportedNodeMessage({ node: "22.0.0", bun: "1.4.2" })).toBeNull();
  });
});
