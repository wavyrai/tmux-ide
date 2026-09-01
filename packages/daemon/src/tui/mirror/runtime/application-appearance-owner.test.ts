import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseAppConfig } from "../../../lib/app-config.ts";
import type { ResolvedThemeMode, ThemeModeSource } from "../theme.ts";
import { createAppearanceOwner } from "./application-appearance-owner.ts";

class ThemeRenderer extends EventEmitter implements ThemeModeSource {
  themeMode: ResolvedThemeMode | null = "dark";
}

const previousConfig = process.env.TMUX_IDE_CONFIG;
const roots: string[] = [];

afterEach(() => {
  if (previousConfig === undefined) delete process.env.TMUX_IDE_CONFIG;
  else process.env.TMUX_IDE_CONFIG = previousConfig;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("createAppearanceOwner", () => {
  it("cycles and persists the theme immediately", () => {
    const root = mkdtempSync(join(tmpdir(), "tmux-ide-appearance-"));
    roots.push(root);
    const path = join(root, "config.json");
    process.env.TMUX_IDE_CONFIG = path;
    const owner = createAppearanceOwner(
      parseAppConfig({ theme: { mode: "dark" } }),
      new ThemeRenderer(),
    );

    owner.cycleTheme();

    expect(owner.theme().setting).toBe("light");
    expect(owner.note()).toBe("theme → light");
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ theme: { mode: "light" } });
    owner.dispose();
  });
});
