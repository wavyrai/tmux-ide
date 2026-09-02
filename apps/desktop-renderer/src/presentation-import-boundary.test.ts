import { describe, expect, it } from "vitest";

const rendererSources = import.meta.glob<string>(["./**/*.ts", "./**/*.tsx", "./**/*.css"], {
  query: "?raw",
  import: "default",
  eager: true,
});

describe("desktop presentation import boundary", () => {
  it("keeps production renderer code independent from daemon implementation modules", () => {
    const violations = Object.entries(rendererSources)
      .filter(([path]) => !/\.(?:test|fixture)\.[^.]+$/u.test(path))
      .filter(([, source]) => source.includes("packages/daemon/src/"))
      .map(([path]) => path)
      .sort();

    expect(violations).toEqual([]);
  });

  it("loads shared pane and dock presentation through the renderer-neutral package", () => {
    const production = Object.entries(rendererSources)
      .filter(([path]) => !/\.(?:test|fixture)\.[^.]+$/u.test(path))
      .map(([, source]) => source)
      .join("\n");

    expect(production).toContain("@tmux-ide/presentation/pane-frame");
    expect(production).toContain("@tmux-ide/presentation/workbench-dock");
  });
});
