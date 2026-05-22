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
  parseAssertionIds,
  checkCoverage,
  type ValidationState,
} from "./validation.ts";
import { ensureTasksDir, saveTask } from "./task-store.ts";
import { makeTask } from "../__tests__/support.ts";

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
        A1: {
          status: "passing",
          verifiedBy: "agent-1",
          verifiedAt: "2026-01-01T00:00:00Z",
          evidence: "tests pass",
          blockedBy: null,
        },
        A2: {
          status: "failing",
          verifiedBy: null,
          verifiedAt: null,
          evidence: null,
          blockedBy: null,
        },
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
        A1: {
          status: "passing",
          verifiedBy: null,
          verifiedAt: null,
          evidence: null,
          blockedBy: null,
        },
        A2: {
          status: "passing",
          verifiedBy: null,
          verifiedAt: null,
          evidence: null,
          blockedBy: null,
        },
      },
      lastVerified: null,
    };
    expect(isAllPassing(state)).toBe(true);
  });

  it("returns false when any assertion is not passing", () => {
    const state: ValidationState = {
      assertions: {
        A1: {
          status: "passing",
          verifiedBy: null,
          verifiedAt: null,
          evidence: null,
          blockedBy: null,
        },
        A2: {
          status: "pending",
          verifiedBy: null,
          verifiedAt: null,
          evidence: null,
          blockedBy: null,
        },
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
        A1: {
          status: "passing",
          verifiedBy: null,
          verifiedAt: null,
          evidence: null,
          blockedBy: null,
        },
        A2: {
          status: "failing",
          verifiedBy: null,
          verifiedAt: null,
          evidence: null,
          blockedBy: null,
        },
        A3: {
          status: "failing",
          verifiedBy: null,
          verifiedAt: null,
          evidence: null,
          blockedBy: null,
        },
      },
      lastVerified: null,
    };
    expect(getFailedAssertions(state)).toEqual(["A2", "A3"]);
  });

  it("returns empty array when no failures", () => {
    const state: ValidationState = {
      assertions: {
        A1: {
          status: "passing",
          verifiedBy: null,
          verifiedAt: null,
          evidence: null,
          blockedBy: null,
        },
      },
      lastVerified: null,
    };
    expect(getFailedAssertions(state)).toEqual([]);
  });

  it("includes blocked assertions", () => {
    const state: ValidationState = {
      assertions: {
        A1: {
          status: "passing",
          verifiedBy: null,
          verifiedAt: null,
          evidence: null,
          blockedBy: null,
        },
        A2: {
          status: "blocked",
          verifiedBy: null,
          verifiedAt: null,
          evidence: null,
          blockedBy: "needs infra",
        },
      },
      lastVerified: null,
    };
    expect(getFailedAssertions(state)).toEqual(["A2"]);
  });
});

describe("blocked assertion status", () => {
  it("isAllPassing returns false when assertion is blocked", () => {
    const state: ValidationState = {
      assertions: {
        A1: {
          status: "passing",
          verifiedBy: null,
          verifiedAt: null,
          evidence: null,
          blockedBy: null,
        },
        A2: {
          status: "blocked",
          verifiedBy: null,
          verifiedAt: null,
          evidence: null,
          blockedBy: "depends on deploy",
        },
      },
      lastVerified: null,
    };
    expect(isAllPassing(state)).toBe(false);
  });
});

describe("parseAssertionIds", () => {
  it("parses ASSERT-style IDs", () => {
    const contract = `# Contract\n**ASSERT01**: Auth works\n**ASSERT02**: Tests pass`;
    expect(parseAssertionIds(contract)).toEqual(["ASSERT01", "ASSERT02"]);
  });

  it("parses VAL-style IDs", () => {
    const contract = `**VAL-AUTH-001**: Endpoint returns 200\n**VAL-DB-002**: Data persists`;
    expect(parseAssertionIds(contract)).toEqual(["VAL-AUTH-001", "VAL-DB-002"]);
  });

  it("deduplicates IDs", () => {
    const contract = `**ASSERT01**: first mention\n**ASSERT01**: second mention`;
    expect(parseAssertionIds(contract)).toEqual(["ASSERT01"]);
  });

  it("returns empty array for no matches", () => {
    expect(parseAssertionIds("No assertions here")).toEqual([]);
  });
});

describe("checkCoverage", () => {
  it("reports unclaimed assertions", () => {
    ensureTasksDir(tmpDir);
    writeFileSync(
      join(tmpDir, ".tasks", "validation-contract.md"),
      "**ASSERT01**: Auth\n**ASSERT02**: Tests\n**ASSERT03**: Deploy",
    );
    // Only ASSERT01 is claimed
    saveTask(tmpDir, makeTask({ id: "001", fulfills: ["ASSERT01"] }));

    const result = checkCoverage(tmpDir);
    expect(result.unclaimed).toEqual(["ASSERT02", "ASSERT03"]);
  });

  it("reports duplicate claims", () => {
    ensureTasksDir(tmpDir);
    writeFileSync(join(tmpDir, ".tasks", "validation-contract.md"), "**ASSERT01**: Auth");
    saveTask(tmpDir, makeTask({ id: "001", fulfills: ["ASSERT01"] }));
    saveTask(tmpDir, makeTask({ id: "002", title: "Other", fulfills: ["ASSERT01"] }));

    const result = checkCoverage(tmpDir);
    expect(result.unclaimed).toEqual([]);
    expect(result.duplicates["ASSERT01"]).toEqual(["001", "002"]);
  });

  it("returns empty when no contract", () => {
    ensureTasksDir(tmpDir);
    const result = checkCoverage(tmpDir);
    expect(result.unclaimed).toEqual([]);
    expect(result.duplicates).toEqual({});
  });

  it("returns full coverage when all claimed", () => {
    ensureTasksDir(tmpDir);
    writeFileSync(
      join(tmpDir, ".tasks", "validation-contract.md"),
      "**ASSERT01**: Auth\n**ASSERT02**: Tests",
    );
    saveTask(tmpDir, makeTask({ id: "001", fulfills: ["ASSERT01", "ASSERT02"] }));

    const result = checkCoverage(tmpDir);
    expect(result.unclaimed).toEqual([]);
    expect(result.duplicates).toEqual({});
  });
});
