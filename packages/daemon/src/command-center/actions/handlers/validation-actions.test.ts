import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validationAssertHandler, validationReportHandler } from "./validation-actions.ts";

let dir: string;
let broadcasts: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tmux-ide-validation-actions-"));
  broadcasts = [];
  mkdirSync(join(dir, ".tasks"), { recursive: true });
  writeFileSync(
    join(dir, ".tasks", "validation-contract.md"),
    "## Contract\n\n- **VAL-001** First assertion\n",
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("validation actions", () => {
  it("asserts validation status and reports totals", () => {
    const result = validationAssertHandler(
      { assertId: "VAL-001", status: "passing", evidence: "unit test" },
      {
        cwd: dir,
        broadcastValidationChanged: (sessionName: string) => broadcasts.push(sessionName),
      },
    );
    expect(result.assertion.status).toBe("passing");
    expect(result.assertion.evidence).toBe("unit test");
    expect(validationReportHandler({}, { cwd: dir }).report).toEqual({
      total: 1,
      passing: 1,
      failing: 0,
      pending: 0,
      blocked: 0,
    });
    expect(broadcasts).toHaveLength(1);
  });

  it("raises validation_assertion_not_found for unknown assertions", () => {
    expect(() =>
      validationAssertHandler({ assertId: "VAL-MISSING", status: "failing" }, { cwd: dir }),
    ).toThrow(/not found in the contract/);
  });
});
