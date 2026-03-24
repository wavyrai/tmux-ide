import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlans, listPlans, markPlanDone, getPlan } from "./plan-store.ts";

let tmpDir: string;

function writePlan(name: string, content: string) {
  const dir = join(tmpDir, "plans");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), content);
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tmux-ide-plans-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadPlans", () => {
  it("returns empty when plans/ does not exist", () => {
    expect(loadPlans(tmpDir)).toEqual([]);
  });

  it("loads plans and parses status", () => {
    writePlan(
      "01-mouse-support",
      "# Plan 01: Mouse Support\n\n**Status:** `done`\n**Effort:** Low\n",
    );
    writePlan(
      "70-hierarchical-agents",
      "# Plan 70: Hierarchical Agents\n\n**Status:** `in-progress`\n**Effort:** High\n**Gate:** agents work\n",
    );

    const plans = loadPlans(tmpDir);
    expect(plans.length).toBe(2);
    expect(plans[0]!.name).toBe("01-mouse-support");
    expect(plans[0]!.status).toBe("done");
    expect(plans[0]!.effort).toBe("Low");
    expect(plans[1]!.name).toBe("70-hierarchical-agents");
    expect(plans[1]!.status).toBe("in-progress");
    expect(plans[1]!.gate).toBe("agents work");
  });

  it("skips ROADMAP.md", () => {
    writePlan("ROADMAP", "# Roadmap\n");
    writePlan("01-test", "# Test\n\n**Status:** `pending`\n");

    const plans = loadPlans(tmpDir);
    expect(plans.length).toBe(1);
    expect(plans[0]!.name).toBe("01-test");
  });

  it("defaults to pending when no status found", () => {
    writePlan("99-no-status", "# No Status Plan\n\nJust content.\n");
    const plans = loadPlans(tmpDir);
    expect(plans[0]!.status).toBe("pending");
  });
});

describe("listPlans", () => {
  it("filters by status", () => {
    writePlan("01-done", "# Done\n\n**Status:** `done`\n");
    writePlan("02-pending", "# Pending\n\n**Status:** `pending`\n");
    writePlan("03-active", "# Active\n\n**Status:** `in-progress`\n");

    const done = listPlans(tmpDir, { status: "done" });
    expect(done.length).toBe(1);
    expect(done[0]!.name).toBe("01-done");

    const active = listPlans(tmpDir, { status: "in-progress" });
    expect(active.length).toBe(1);
    expect(active[0]!.name).toBe("03-active");
  });

  it("returns all when no filter", () => {
    writePlan("01-a", "# A\n\n**Status:** `done`\n");
    writePlan("02-b", "# B\n\n**Status:** `pending`\n");

    expect(listPlans(tmpDir).length).toBe(2);
  });
});

describe("markPlanDone", () => {
  it("updates status to done and adds completed date", () => {
    writePlan(
      "50-task-cli",
      "# Plan 50: Task CLI\n\n**Status:** `in-progress`\n**Effort:** Medium\n",
    );

    const result = markPlanDone(tmpDir, "50");
    expect(result).toBeTruthy();
    expect(result!.status).toBe("done");
    expect(result!.completed).toBeTruthy();

    // Verify file was updated
    const content = readFileSync(join(tmpDir, "plans", "50-task-cli.md"), "utf-8");
    expect(content.includes("**Status:** `done`")).toBeTruthy();
    expect(content.includes("**Completed:**")).toBeTruthy();
  });

  it("matches by full name", () => {
    writePlan("my-plan", "# My Plan\n\n**Status:** `pending`\n");
    const result = markPlanDone(tmpDir, "my-plan");
    expect(result).toBeTruthy();
    expect(result!.status).toBe("done");
  });

  it("matches by number prefix", () => {
    writePlan("70-hierarchical-agents", "# Plan 70\n\n**Status:** `in-progress`\n");
    const result = markPlanDone(tmpDir, "70");
    expect(result).toBeTruthy();
  });

  it("returns null for non-existent plan", () => {
    expect(markPlanDone(tmpDir, "nonexistent")).toBe(null);
  });

  it("preserves existing completed date format on re-mark", () => {
    writePlan("01-test", "# Test\n\n**Status:** `done`\n**Completed:** 2026-01-01\n");
    const result = markPlanDone(tmpDir, "01");
    expect(result).toBeTruthy();
    // Should update the date
    expect(result!.completed).not.toBe("2026-01-01");
  });
});

describe("getPlan", () => {
  it("finds by name", () => {
    writePlan("50-task-cli", "# Plan 50\n\n**Status:** `done`\n");
    const plan = getPlan(tmpDir, "50-task-cli");
    expect(plan).toBeTruthy();
    expect(plan!.name).toBe("50-task-cli");
  });

  it("finds by number prefix", () => {
    writePlan("50-task-cli", "# Plan 50\n\n**Status:** `done`\n");
    const plan = getPlan(tmpDir, "50");
    expect(plan).toBeTruthy();
  });

  it("returns null when not found", () => {
    expect(getPlan(tmpDir, "99")).toBe(null);
  });
});
