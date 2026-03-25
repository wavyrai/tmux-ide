import { describe, it, expect } from "bun:test";
import { validateConfig } from "./validate.ts";

describe("validateConfig", () => {
  it("accepts a valid minimal config", () => {
    const errors = validateConfig({ rows: [{ panes: [{}] }] });
    expect(errors).toEqual([]);
  });

  it("accepts a valid full config", () => {
    const errors = validateConfig({
      name: "my-project",
      before: "pnpm install",
      rows: [
        {
          size: "70%",
          panes: [
            {
              title: "Editor",
              command: "vim",
              dir: "src",
              size: "60%",
              focus: true,
              env: { PORT: 3000, HOST: "localhost" },
            },
            { title: "Shell" },
          ],
        },
        {
          panes: [{ title: "Dev", command: "pnpm dev" }],
        },
      ],
      theme: { accent: "colour75", border: "colour238", bg: "colour235", fg: "colour248" },
    });
    expect(errors).toEqual([]);
  });

  it("rejects null config", () => {
    const errors = validateConfig(null);
    expect(errors).toEqual(["config must be an object"]);
  });

  it("rejects string config", () => {
    const errors = validateConfig("hello");
    expect(errors).toEqual(["config must be an object"]);
  });

  it("rejects array config", () => {
    const errors = validateConfig([]);
    expect(errors).toEqual(["config must be an object"]);
  });

  it("requires rows to be an array", () => {
    const errors = validateConfig({ rows: "nope" });
    expect(errors.includes("'rows' must be an array")).toBeTruthy();
  });

  it("requires rows to be non-empty", () => {
    const errors = validateConfig({ rows: [] });
    expect(errors.includes("'rows' must not be empty")).toBeTruthy();
  });

  it("requires rows to have a panes array", () => {
    const errors = validateConfig({ rows: [{}] });
    expect(errors.includes("rows[0].panes must be an array")).toBeTruthy();
  });

  it("requires panes to be non-empty", () => {
    const errors = validateConfig({ rows: [{ panes: [] }] });
    expect(errors.includes("rows[0].panes must not be empty")).toBeTruthy();
  });

  it("rejects non-string name", () => {
    const errors = validateConfig({ name: 123, rows: [{ panes: [{}] }] });
    expect(errors.includes("'name' must be a string")).toBeTruthy();
  });

  it("rejects non-string before", () => {
    const errors = validateConfig({ before: true, rows: [{ panes: [{}] }] });
    expect(errors.includes("'before' must be a string")).toBeTruthy();
  });

  it("rejects non-string pane.title", () => {
    const errors = validateConfig({ rows: [{ panes: [{ title: 42 }] }] });
    expect(errors.includes("rows[0].panes[0].title must be a string")).toBeTruthy();
  });

  it("rejects non-string pane.command", () => {
    const errors = validateConfig({ rows: [{ panes: [{ command: false }] }] });
    expect(errors.includes("rows[0].panes[0].command must be a string")).toBeTruthy();
  });

  it("rejects non-string pane.dir", () => {
    const errors = validateConfig({ rows: [{ panes: [{ dir: [] }] }] });
    expect(errors.includes("rows[0].panes[0].dir must be a string")).toBeTruthy();
  });

  it("rejects non-boolean pane.focus", () => {
    const errors = validateConfig({ rows: [{ panes: [{ focus: "yes" }] }] });
    expect(errors.includes("rows[0].panes[0].focus must be a boolean")).toBeTruthy();
  });

  it("rejects non-object pane.env", () => {
    const errors = validateConfig({ rows: [{ panes: [{ env: "PORT=3000" }] }] });
    expect(errors.includes("rows[0].panes[0].env must be an object")).toBeTruthy();
  });

  it("rejects invalid env values", () => {
    const errors = validateConfig({ rows: [{ panes: [{ env: { PORT: true } }] }] });
    expect(errors.includes("rows[0].panes[0].env.PORT must be a string or number")).toBeTruthy();
  });

  it("rejects size without % suffix", () => {
    const errors = validateConfig({ rows: [{ size: "70", panes: [{}] }] });
    expect(errors.some((e) => e.includes("must be a percentage"))).toBeTruthy();
  });

  it("rejects 0% size", () => {
    const errors = validateConfig({ rows: [{ size: "0%", panes: [{}] }] });
    expect(errors.some((e) => e.includes("must be a percentage"))).toBeTruthy();
  });

  it("rejects >100% size", () => {
    const errors = validateConfig({ rows: [{ panes: [{ size: "150%" }] }] });
    expect(errors.some((e) => e.includes("must not exceed 100%"))).toBeTruthy();
  });

  it("validates theme fields as strings", () => {
    const errors = validateConfig({ rows: [{ panes: [{}] }], theme: { accent: 123 } });
    expect(errors.includes("theme.accent must be a string")).toBeTruthy();
  });

  it("accepts team metadata without requiring a lead pane", () => {
    const errors = validateConfig({
      team: { name: "my-team" },
      rows: [
        {
          panes: [{ title: "Claude", command: "claude" }, { title: "Shell" }],
        },
      ],
    });
    expect(errors).toEqual([]);
  });

  it("validates team pane role and task field types when provided", () => {
    const errors = validateConfig({
      team: { name: "my-team" },
      rows: [
        {
          panes: [
            { command: "claude", role: "manager", task: false },
            { command: "claude", role: "teammate", task: "Review changes" },
          ],
        },
      ],
    });
    expect(
      errors.includes('rows[0].panes[0].role must be "lead", "teammate", or "planner"'),
    ).toBeTruthy();
    expect(errors.includes("rows[0].panes[0].task must be a string")).toBeTruthy();
  });

  it("rejects non-object theme", () => {
    const errors = validateConfig({ rows: [{ panes: [{}] }], theme: "blue" });
    expect(errors.includes("'theme' must be an object")).toBeTruthy();
  });

  it("rejects leading zeros in size (00%, 007%)", () => {
    const errors = validateConfig({ rows: [{ size: "007%", panes: [{ size: "00%" }] }] });
    expect(
      errors.some((e) => e.includes('rows[0].size "007%"') && e.includes("percentage")),
    ).toBeTruthy();
    expect(
      errors.some((e) => e.includes('rows[0].panes[0].size "00%"') && e.includes("percentage")),
    ).toBeTruthy();
  });

  it("rejects row sizes summing over 100%", () => {
    const errors = validateConfig({
      rows: [
        { size: "70%", panes: [{}] },
        { size: "40%", panes: [{}] },
      ],
    });
    expect(errors.some((e) => e.includes("Row sizes sum to 110%"))).toBeTruthy();
  });

  it("accepts row sizes summing to exactly 100%", () => {
    const errors = validateConfig({
      rows: [
        { size: "70%", panes: [{}] },
        { size: "30%", panes: [{}] },
      ],
    });
    expect(errors).toEqual([]);
  });

  it("rejects multiple focus: true in one row", () => {
    const errors = validateConfig({
      rows: [{ panes: [{ focus: true }, { focus: true }] }],
    });
    expect(errors.some((e) => e.includes("Row 0 has 2 panes with focus: true"))).toBeTruthy();
  });

  it("accepts single focus: true per row", () => {
    const errors = validateConfig({
      rows: [{ panes: [{ focus: true }, {}] }, { panes: [{}, { focus: true }] }],
    });
    expect(errors).toEqual([]);
  });

  it("rejects pane sizes summing over 100% in a row", () => {
    const errors = validateConfig({
      rows: [{ panes: [{ size: "60%" }, { size: "50%" }] }],
    });
    expect(errors.some((e) => e.includes("Row 0 pane sizes sum to 110%"))).toBeTruthy();
  });

  it("accepts pane sizes summing to exactly 100%", () => {
    const errors = validateConfig({
      rows: [{ panes: [{ size: "60%" }, { size: "40%" }] }],
    });
    expect(errors).toEqual([]);
  });

  it("accepts type: explorer pane", () => {
    const errors = validateConfig({
      rows: [{ panes: [{ type: "explorer", title: "Files" }] }],
    });
    expect(errors).toEqual([]);
  });

  it("accepts type: changes pane", () => {
    const errors = validateConfig({
      rows: [{ panes: [{ type: "changes", title: "Changes" }] }],
    });
    expect(errors).toEqual([]);
  });

  it("accepts type: preview pane", () => {
    const errors = validateConfig({
      rows: [{ panes: [{ type: "preview", title: "Preview" }] }],
    });
    expect(errors).toEqual([]);
  });

  it("accepts type: tasks pane", () => {
    const errors = validateConfig({
      rows: [{ panes: [{ type: "tasks", title: "Tasks" }] }],
    });
    expect(errors).toEqual([]);
  });

  it("accepts type: mission-control pane", () => {
    const errors = validateConfig({
      rows: [{ panes: [{ type: "mission-control", title: "Mission Control" }] }],
    });
    expect(errors).toEqual([]);
  });

  it("accepts type: costs pane", () => {
    const errors = validateConfig({
      rows: [{ panes: [{ type: "costs", title: "Costs" }] }],
    });
    expect(errors).toEqual([]);
  });

  it("rejects invalid type value", () => {
    const errors = validateConfig({
      rows: [{ panes: [{ type: "invalid" }] }],
    });
    expect(errors.some((e) => e.includes("rows[0].panes[0].type must be one of:"))).toBeTruthy();
  });

  it("rejects type and command together", () => {
    const errors = validateConfig({
      rows: [{ panes: [{ type: "explorer", command: "vim" }] }],
    });
    expect(errors.includes("rows[0].panes[0] cannot have both 'type' and 'command'")).toBeTruthy();
  });

  it("rejects non-string target", () => {
    const errors = validateConfig({
      rows: [{ panes: [{ target: 42 }] }],
    });
    expect(errors.includes("rows[0].panes[0].target must be a string")).toBeTruthy();
  });

  it("accepts string target", () => {
    const errors = validateConfig({
      rows: [{ panes: [{ type: "explorer", target: "Claude" }] }],
    });
    expect(errors).toEqual([]);
  });

  it("accepts valid orchestrator config", () => {
    const errors = validateConfig({
      rows: [{ panes: [{}] }],
      orchestrator: {
        enabled: true,
        auto_dispatch: true,
        stall_timeout: 300000,
        poll_interval: 5000,
        worktree_root: ".worktrees/",
        master_pane: "Master",
      },
    });
    expect(errors).toEqual([]);
  });

  it("accepts config without orchestrator", () => {
    const errors = validateConfig({ rows: [{ panes: [{}] }] });
    expect(errors).toEqual([]);
  });

  it("rejects non-object orchestrator", () => {
    const errors = validateConfig({
      rows: [{ panes: [{}] }],
      orchestrator: "enabled",
    });
    expect(errors.includes("'orchestrator' must be an object")).toBeTruthy();
  });

  it("rejects orchestrator with wrong field types", () => {
    const errors = validateConfig({
      rows: [{ panes: [{}] }],
      orchestrator: {
        enabled: "yes",
        auto_dispatch: 1,
        stall_timeout: "5000",
        poll_interval: true,
        worktree_root: 42,
        master_pane: false,
      },
    });
    expect(errors.includes("orchestrator.enabled must be a boolean")).toBeTruthy();
    expect(errors.includes("orchestrator.auto_dispatch must be a boolean")).toBeTruthy();
    expect(errors.includes("orchestrator.stall_timeout must be a number (ms)")).toBeTruthy();
    expect(errors.includes("orchestrator.poll_interval must be a number (ms)")).toBeTruthy();
    expect(errors.includes("orchestrator.worktree_root must be a string")).toBeTruthy();
    expect(errors.includes("orchestrator.master_pane must be a string")).toBeTruthy();
  });

  it("accepts orchestrator with only some fields", () => {
    const errors = validateConfig({
      rows: [{ panes: [{}] }],
      orchestrator: { enabled: true },
    });
    expect(errors).toEqual([]);
  });

  it("accepts valid orchestrator hook and concurrency fields", () => {
    const errors = validateConfig({
      rows: [{ panes: [{}] }],
      orchestrator: {
        before_run: "pnpm install",
        after_run: "pnpm test",
        cleanup_on_done: true,
        max_concurrent_agents: 3,
        dispatch_mode: "goals",
      },
    });
    expect(errors).toEqual([]);
  });

  it("rejects orchestrator hook and concurrency fields with wrong types", () => {
    const errors = validateConfig({
      rows: [{ panes: [{}] }],
      orchestrator: {
        before_run: 123,
        after_run: false,
        cleanup_on_done: "yes",
        max_concurrent_agents: "ten",
      },
    });
    expect(errors.includes("orchestrator.before_run must be a string")).toBeTruthy();
    expect(errors.includes("orchestrator.after_run must be a string")).toBeTruthy();
    expect(errors.includes("orchestrator.cleanup_on_done must be a boolean")).toBeTruthy();
    expect(errors.includes("orchestrator.max_concurrent_agents must be a number")).toBeTruthy();
  });

  it("collects multiple errors at once", () => {
    const errors = validateConfig({
      name: 123,
      before: [],
      rows: [{ panes: [{ title: 42, focus: "yes", size: "0%" }] }],
      theme: "nope",
    });
    expect(errors.length >= 4).toBeTruthy();
  });
});
