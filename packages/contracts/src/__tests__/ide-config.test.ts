/**
 * Schema tests for the `sidebar` ide.yml sugar (M15.2).
 */
import { describe, expect, it } from "vitest";
import { IdeConfigSchema, SidebarConfigSchema } from "../ide-config";

const base = { rows: [{ panes: [{ title: "shell" }] }] };

describe("SidebarConfigSchema", () => {
  it("accepts the boolean form", () => {
    expect(SidebarConfigSchema.parse(true)).toBe(true);
    expect(SidebarConfigSchema.parse(false)).toBe(false);
  });

  it("accepts the object form with an optional width", () => {
    expect(SidebarConfigSchema.parse({ width: "30" })).toEqual({ width: "30" });
    expect(SidebarConfigSchema.parse({})).toEqual({});
  });

  it("rejects a bare number", () => {
    expect(() => SidebarConfigSchema.parse(30)).toThrow();
  });
});

describe("IdeConfigSchema — sidebar", () => {
  it("parses `sidebar: true`", () => {
    const cfg = IdeConfigSchema.parse({ ...base, sidebar: true });
    expect(cfg.sidebar).toBe(true);
  });

  it("parses `sidebar: { width }`", () => {
    const cfg = IdeConfigSchema.parse({ ...base, sidebar: { width: "40" } });
    expect(cfg.sidebar).toEqual({ width: "40" });
  });

  it("leaves sidebar undefined when omitted", () => {
    expect(IdeConfigSchema.parse(base).sidebar).toBeUndefined();
  });

  it("accepts a pane of type sidebar", () => {
    const cfg = IdeConfigSchema.parse({
      rows: [{ panes: [{ title: "nav", type: "sidebar" }] }],
    });
    expect(cfg.rows[0]!.panes[0]!.type).toBe("sidebar");
  });
});

describe("IdeConfigSchema — pane identity", () => {
  it("accepts workspace-safe explicit pane ids", () => {
    const config = IdeConfigSchema.parse({
      rows: [{ panes: [{ id: "agent.lead-1", title: "Lead" }] }],
    });
    expect(config.rows[0]!.panes[0]!.id).toBe("agent.lead-1");
  });

  it("rejects invalid and duplicate explicit pane ids", () => {
    expect(() => IdeConfigSchema.parse({ rows: [{ panes: [{ id: "bad id" }] }] })).toThrow();
    expect(() =>
      IdeConfigSchema.parse({
        rows: [{ panes: [{ id: "agent" }] }, { panes: [{ id: "agent" }] }],
      }),
    ).toThrow(/Duplicate pane id/u);
  });
});
