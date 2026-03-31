import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadValidationContract,
  loadValidationState,
  saveValidationState,
  isAllPassing,
  getFailedAssertions,
  type ValidationState,
} from "./validation.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tmux-ide-validation-test-"));
  mkdirSync(join(tmpDir, ".tasks"), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadValidationContract", () => {
  it("returns null when file does not exist", () => {
    expect(loadValidationContract(tmpDir)).toBeNull();
  });

  it("reads the contract file", () => {
    writeFileSync(join(tmpDir, ".tasks", "validation-contract.md"), "# Contract\n- [A1] test");
    expect(loadValidationContract(tmpDir)).toBe("# Contract\n- [A1] test");
  });
});

describe("loadValidationState / saveValidationState", () => {
  it("returns null when file does not exist", () => {
    expect(loadValidationState(tmpDir)).toBeNull();
  });

  it("round-trips state", () => {
    const state: ValidationState = {
      assertions: {
        A1: { status: "passing", verifiedBy: "agent-1", verifiedAt: "2026-01-01T00:00:00Z", evidence: "tests pass" },
        A2: { status: "failing", verifiedBy: null, verifiedAt: null, evidence: null },
      },
      lastVerified: "2026-01-01T00:00:00Z",
    };
    saveValidationState(tmpDir, state);
    const loaded = loadValidationState(tmpDir);
    expect(loaded).toEqual(state);
  });

  it("returns null for corrupted file", () => {
    writeFileSync(join(tmpDir, ".tasks", "validation-state.json"), "not json");
    expect(loadValidationState(tmpDir)).toBeNull();
  });
});

describe("isAllPassing", () => {
  it("returns true when all assertions pass", () => {
    const state: ValidationState = {
      assertions: {
        A1: { status: "passing", verifiedBy: null, verifiedAt: null, evidence: null },
        A2: { status: "passing", verifiedBy: null, verifiedAt: null, evidence: null },
      },
      lastVerified: null,
    };
    expect(isAllPassing(state)).toBe(true);
  });

  it("returns false when any assertion is not passing", () => {
    const state: ValidationState = {
      assertions: {
        A1: { status: "passing", verifiedBy: null, verifiedAt: null, evidence: null },
        A2: { status: "pending", verifiedBy: null, verifiedAt: null, evidence: null },
      },
      lastVerified: null,
    };
    expect(isAllPassing(state)).toBe(false);
  });

  it("returns false for empty assertions", () => {
    expect(isAllPassing({ assertions: {}, lastVerified: null })).toBe(false);
  });
});

describe("getFailedAssertions", () => {
  it("returns IDs of failing assertions", () => {
    const state: ValidationState = {
      assertions: {
        A1: { status: "passing", verifiedBy: null, verifiedAt: null, evidence: null },
        A2: { status: "failing", verifiedBy: null, verifiedAt: null, evidence: null },
        A3: { status: "failing", verifiedBy: null, verifiedAt: null, evidence: null },
      },
      lastVerified: null,
    };
    expect(getFailedAssertions(state)).toEqual(["A2", "A3"]);
  });

  it("returns empty array when no failures", () => {
    const state: ValidationState = {
      assertions: {
        A1: { status: "passing", verifiedBy: null, verifiedAt: null, evidence: null },
      },
      lastVerified: null,
    };
    expect(getFailedAssertions(state)).toEqual([]);
  });
});
