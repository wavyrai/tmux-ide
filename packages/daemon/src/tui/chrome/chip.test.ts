/** Unit tests for the pure pane-chip builder. */
import { describe, expect, it } from "vitest";
import { paneChip } from "./chip.ts";
import { DEFAULT_THEME, type AppTheme } from "../../lib/app-config.ts";

describe("paneChip", () => {
  it("renders `agent · status` with the state's color markup", () => {
    expect(paneChip("claude", "working")).toBe("#[fg=colour221]claude · working#[default]");
    expect(paneChip("codex", "blocked")).toBe("#[fg=colour203,bold]codex · blocked#[default]");
    expect(paneChip("claude", "done")).toBe("#[fg=colour111]claude · done#[default]");
    expect(paneChip("claude", "idle")).toBe("#[fg=colour114]claude · idle#[default]");
    expect(paneChip("gemini", "unknown")).toBe("#[fg=colour244]gemini · unknown#[default]");
  });

  it("returns an empty chip for a non-agent pane (null agent)", () => {
    expect(paneChip(null, "idle")).toBe("");
    expect(paneChip(null, "working")).toBe("");
  });

  it("styles the chip with a custom theme's status colors (bold kept for blocked)", () => {
    const theme: AppTheme = {
      ...DEFAULT_THEME,
      status: { ...DEFAULT_THEME.status, working: "colour45", blocked: "colour99" },
    };
    expect(paneChip("claude", "working", theme)).toBe("#[fg=colour45]claude · working#[default]");
    expect(paneChip("codex", "blocked", theme)).toBe(
      "#[fg=colour99,bold]codex · blocked#[default]",
    );
  });
});
