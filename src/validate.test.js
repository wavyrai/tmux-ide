import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateConfig } from "./validate.js";

describe("validateConfig", () => {
  it("accepts a valid minimal config", () => {
    const errors = validateConfig({ rows: [{ panes: [{}] }] });
    assert.deepStrictEqual(errors, []);
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
    assert.deepStrictEqual(errors, []);
  });

  it("rejects null config", () => {
    const errors = validateConfig(null);
    assert.deepStrictEqual(errors, ["config must be an object"]);
  });

  it("rejects string config", () => {
    const errors = validateConfig("hello");
    assert.deepStrictEqual(errors, ["config must be an object"]);
  });

  it("rejects array config", () => {
    const errors = validateConfig([]);
    assert.deepStrictEqual(errors, ["config must be an object"]);
  });

  it("requires rows to be an array", () => {
    const errors = validateConfig({ rows: "nope" });
    assert.ok(errors.includes("'rows' must be an array"));
  });

  it("requires rows to be non-empty", () => {
    const errors = validateConfig({ rows: [] });
    assert.ok(errors.includes("'rows' must not be empty"));
  });

  it("requires rows to have a panes array", () => {
    const errors = validateConfig({ rows: [{}] });
    assert.ok(errors.includes("rows[0].panes must be an array"));
  });

  it("requires panes to be non-empty", () => {
    const errors = validateConfig({ rows: [{ panes: [] }] });
    assert.ok(errors.includes("rows[0].panes must not be empty"));
  });

  it("rejects non-string name", () => {
    const errors = validateConfig({ name: 123, rows: [{ panes: [{}] }] });
    assert.ok(errors.includes("'name' must be a string"));
  });

  it("rejects non-string before", () => {
    const errors = validateConfig({ before: true, rows: [{ panes: [{}] }] });
    assert.ok(errors.includes("'before' must be a string"));
  });

  it("rejects non-string pane.title", () => {
    const errors = validateConfig({ rows: [{ panes: [{ title: 42 }] }] });
    assert.ok(errors.includes("rows[0].panes[0].title must be a string"));
  });

  it("rejects non-string pane.command", () => {
    const errors = validateConfig({ rows: [{ panes: [{ command: false }] }] });
    assert.ok(errors.includes("rows[0].panes[0].command must be a string"));
  });

  it("rejects non-string pane.dir", () => {
    const errors = validateConfig({ rows: [{ panes: [{ dir: [] }] }] });
    assert.ok(errors.includes("rows[0].panes[0].dir must be a string"));
  });

  it("rejects non-boolean pane.focus", () => {
    const errors = validateConfig({ rows: [{ panes: [{ focus: "yes" }] }] });
    assert.ok(errors.includes("rows[0].panes[0].focus must be a boolean"));
  });

  it("rejects non-object pane.env", () => {
    const errors = validateConfig({ rows: [{ panes: [{ env: "PORT=3000" }] }] });
    assert.ok(errors.includes("rows[0].panes[0].env must be an object"));
  });

  it("rejects invalid env values", () => {
    const errors = validateConfig({ rows: [{ panes: [{ env: { PORT: true } }] }] });
    assert.ok(errors.includes("rows[0].panes[0].env.PORT must be a string or number"));
  });

  it("rejects size without % suffix", () => {
    const errors = validateConfig({ rows: [{ size: "70", panes: [{}] }] });
    assert.ok(errors.some((e) => e.includes("must be a percentage")));
  });

  it("rejects 0% size", () => {
    const errors = validateConfig({ rows: [{ size: "0%", panes: [{}] }] });
    assert.ok(errors.some((e) => e.includes("must be a percentage")));
  });

  it("rejects >100% size", () => {
    const errors = validateConfig({ rows: [{ panes: [{ size: "150%" }] }] });
    assert.ok(errors.some((e) => e.includes("must not exceed 100%")));
  });

  it("validates theme fields as strings", () => {
    const errors = validateConfig({ rows: [{ panes: [{}] }], theme: { accent: 123 } });
    assert.ok(errors.includes("theme.accent must be a string"));
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
    assert.deepStrictEqual(errors, []);
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
    assert.ok(errors.includes('rows[0].panes[0].role must be "lead" or "teammate"'));
    assert.ok(errors.includes("rows[0].panes[0].task must be a string"));
  });

  it("rejects non-object theme", () => {
    const errors = validateConfig({ rows: [{ panes: [{}] }], theme: "blue" });
    assert.ok(errors.includes("'theme' must be an object"));
  });

  it("rejects leading zeros in size (00%, 007%)", () => {
    const errors = validateConfig({ rows: [{ size: "007%", panes: [{ size: "00%" }] }] });
    assert.ok(errors.some((e) => e.includes('rows[0].size "007%"') && e.includes("percentage")));
    assert.ok(
      errors.some((e) => e.includes('rows[0].panes[0].size "00%"') && e.includes("percentage")),
    );
  });

  it("rejects row sizes summing over 100%", () => {
    const errors = validateConfig({
      rows: [
        { size: "70%", panes: [{}] },
        { size: "40%", panes: [{}] },
      ],
    });
    assert.ok(errors.some((e) => e.includes("Row sizes sum to 110%")));
  });

  it("accepts row sizes summing to exactly 100%", () => {
    const errors = validateConfig({
      rows: [
        { size: "70%", panes: [{}] },
        { size: "30%", panes: [{}] },
      ],
    });
    assert.deepStrictEqual(errors, []);
  });

  it("rejects multiple focus: true in one row", () => {
    const errors = validateConfig({
      rows: [{ panes: [{ focus: true }, { focus: true }] }],
    });
    assert.ok(errors.some((e) => e.includes("Row 0 has 2 panes with focus: true")));
  });

  it("accepts single focus: true per row", () => {
    const errors = validateConfig({
      rows: [{ panes: [{ focus: true }, {}] }, { panes: [{}, { focus: true }] }],
    });
    assert.deepStrictEqual(errors, []);
  });

  it("rejects pane sizes summing over 100% in a row", () => {
    const errors = validateConfig({
      rows: [{ panes: [{ size: "60%" }, { size: "50%" }] }],
    });
    assert.ok(errors.some((e) => e.includes("Row 0 pane sizes sum to 110%")));
  });

  it("accepts pane sizes summing to exactly 100%", () => {
    const errors = validateConfig({
      rows: [{ panes: [{ size: "60%" }, { size: "40%" }] }],
    });
    assert.deepStrictEqual(errors, []);
  });

  it("collects multiple errors at once", () => {
    const errors = validateConfig({
      name: 123,
      before: [],
      rows: [{ panes: [{ title: 42, focus: "yes", size: "0%" }] }],
      theme: "nope",
    });
    assert.ok(errors.length >= 4);
  });
});
