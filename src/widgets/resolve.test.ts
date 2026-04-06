import { describe, it, expect } from "bun:test";
import { resolveWidgetCommand } from "./resolve.ts";

describe("resolveWidgetCommand", () => {
  it("runs widgets from the tmux-ide package root instead of the target project dir", () => {
    const command = resolveWidgetCommand("tasks", {
      session: "demo",
      dir: "/tmp/project",
      target: null,
      theme: null,
    });

    expect(command).toContain("bun ");
    expect(command).toContain("--session=demo");
    expect(command).toContain("--dir=/tmp/project");
    expect(command).not.toContain("cd /tmp/project &&");
  });
});
