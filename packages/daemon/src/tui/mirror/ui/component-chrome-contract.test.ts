import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { SHELL_STATUS_ROWS, SHELL_TABBAR_ROWS, shellChromeLayout } from "../shell-chrome.ts";

const mirrorRoot = fileURLToPath(new URL("../", import.meta.url));

const PRESENTATION_SOURCES = [
  "shell-chrome-view.tsx",
  "runtime/application-shell-home.tsx",
  "runtime/application-shell-catalog.tsx",
  "runtime/application-shell-overlay-stack.tsx",
  "runtime/application-shell-overlays.tsx",
  "runtime/application-shell-sidebar.tsx",
  "runtime/application-terminal-workspace-policy.ts",
  "ui/agent-badge.tsx",
  "ui/badge.tsx",
  "ui/button.tsx",
  "ui/dialog.tsx",
  "ui/key-hint.tsx",
  "ui/menu.tsx",
  "ui/navigation-row.tsx",
  "ui/overlay-frame.tsx",
  "ui/state.ts",
  "ui/status-bar.tsx",
  "ui/surface.tsx",
  "ui/tabs.tsx",
  "workspace/application-shell-view.tsx",
  "workspace/pane-frame.tsx",
  "workspace/terminal-pane-header.tsx",
  "workspace/terminal-window-strip.tsx",
] as const;

const FORBIDDEN_PRESENTATION_IMPORT =
  /(?:^|\/)(?:runtime|command-center)(?:\/|$)|(?:control|workspace)-client|tmux-bridge|pane-(?:stream|surface|mirror)|framebuffer/u;
const FORBIDDEN_APPEARANCE_OWNER =
  /\b(?:createSemanticThemeSnapshot|createThemeStore|resolveVisualTheme|RGBA\.from(?:Hex|Ints))\b|#[\da-f]{6,8}\b|\bcolour\d+\b/iu;

function runtimeImports(source: string): string[] {
  return [
    ...source.matchAll(/\bfrom\s+["']([^"']+)["']/gu),
    ...source.matchAll(/^\s*import\s*["']([^"']+)["']/gmu),
  ].map((match) => match[1]!);
}

describe("OpenTUI component and chrome contract", () => {
  it.each([
    [200, 60, "wide", 28, 172, 57, 56],
    [120, 40, "standard", 28, 92, 37, 36],
    [80, 24, "compact", 20, 60, 21, 20],
  ] as const)(
    "preserves the one-row chrome and terminal body budget at %ix%i",
    (width, height, variant, sidebarWidth, mainWidth, paneFrameRows, terminalBodyRows) => {
      const layout = shellChromeLayout(width, height, 28);
      const contentRows = layout.main.height - layout.status.height;
      const projectedPaneFrameRows = contentRows - 1; // terminal window strip
      expect({
        variant: layout.variant,
        sidebarWidth: layout.sidebar.width,
        mainWidth: layout.main.width,
        appBarRows: layout.tabbar.height,
        statusRows: layout.status.height,
        paneFrameRows: projectedPaneFrameRows,
        terminalBodyRows: projectedPaneFrameRows - 1, // pane title row
      }).toEqual({
        variant,
        sidebarWidth,
        mainWidth,
        appBarRows: 1,
        statusRows: 1,
        paneFrameRows,
        terminalBodyRows,
      });
      expect(SHELL_TABBAR_ROWS).toBe(1);
      expect(SHELL_STATUS_ROWS).toBe(1);
    },
  );

  it("keeps component presentation outside runtime, terminal, and appearance ownership", () => {
    const violations: string[] = [];
    for (const relativePath of PRESENTATION_SOURCES) {
      const source = readFileSync(join(mirrorRoot, relativePath), "utf8");
      for (const specifier of runtimeImports(source)) {
        if (FORBIDDEN_PRESENTATION_IMPORT.test(specifier))
          violations.push(`${relativePath}: forbidden import ${specifier}`);
      }
      if (FORBIDDEN_APPEARANCE_OWNER.test(source))
        violations.push(`${relativePath}: owns raw appearance construction or color`);
    }
    expect(violations).toEqual([]);
  });
});
