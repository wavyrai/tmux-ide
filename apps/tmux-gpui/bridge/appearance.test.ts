import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VISUAL_THEME_PRESETS,
  resolveVisualTheme,
  createVisualTerminalPalette,
  XTERM_PALETTE,
} from "@tmux-ide/contracts";
import { parseAppConfig } from "../../../packages/daemon/src/lib/app-config.ts";
import { appearanceOptions, createAppearanceOwner, resolveNativeAppearance } from "./appearance.ts";

test("real shared config preserves unrelated fields and restores selection in a fresh helper process", async () => {
  const root = await mkdtemp(join(tmpdir(), "gpui-theme-restart-"));
  const config = join(root, "config.json");
  const moduleUrl = new URL("./appearance.ts", import.meta.url).href;
  try {
    await writeFile(config, JSON.stringify({ theme: { mode: "dark" }, unrelated: { keep: 42 } }));
    const run = (select: boolean) =>
      execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `import { createAppearanceOwner } from ${JSON.stringify(moduleUrl)};
         const owner = createAppearanceOwner();
         ${select ? 'owner.select("nord");' : ""}
         process.stdout.write(JSON.stringify(owner.publication()));`,
        ],
        {
          encoding: "utf8",
          env: { PATH: process.env.PATH, HOME: root, TMUX_IDE_HOME: root, TMUX_IDE_CONFIG: config },
        },
      );
    assert.equal(JSON.parse(run(true)).selected, "nord");
    assert.equal(JSON.parse(run(false)).selected, "nord");
    assert.deepEqual(JSON.parse(await readFile(config, "utf8")).unrelated, { keep: 42 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native appearance exposes every canonical preset once and preserves indexed color semantics", () => {
  assert.equal(new Set(appearanceOptions.map((o) => o.id)).size, appearanceOptions.length);
  assert.deepEqual(
    appearanceOptions
      .slice(3)
      .map((o) => o.id)
      .sort(),
    VISUAL_THEME_PRESETS.map((o) => o.id).sort(),
  );
  for (const preset of VISUAL_THEME_PRESETS) {
    const appearance = resolveNativeAppearance(preset.id, "dark");
    const tokens = resolveVisualTheme({ userTheme: preset }).tokens;
    const pack = (color: { red: number; green: number; blue: number }) =>
      (color.red << 16) | (color.green << 8) | color.blue;
    assert.equal(appearance.theme.foreground, pack(tokens.text.primary));
    assert.equal(appearance.theme.background, pack(tokens.surfaces.terminal));
    assert.equal(appearance.theme.palette.length, 256);
    assert.deepEqual(appearance.theme.palette.slice(16), XTERM_PALETTE.slice(16));
    assert.equal(appearance.theme.palette[1], pack(tokens.statusTone.danger));
    assert.ok(
      appearance.theme.palette.every((color) => Number.isInteger(color) && color <= 0xffffff),
    );
  }
});

test("system follows native appearance without persisting a host event; explicit themes stay pinned", () => {
  const owner = createAppearanceOwner({
    read: () => parseAppConfig({ theme: { mode: "system" } }),
    write: () => {
      throw new Error("host event must not save config");
    },
  });
  owner.setSystem("light");
  assert.equal(owner.publication().selected, "system");
  assert.equal(
    owner.publication().theme.background,
    resolveNativeAppearance("light", "light").theme.background,
  );
  assert.deepEqual(
    resolveNativeAppearance("nord", "light").theme,
    resolveNativeAppearance("nord", "dark").theme,
  );
});

test("theme save uses shared patch, restart restores selection, and failed writes retain applied appearance", () => {
  let raw = { theme: { preset: "nord", mode: "dark" }, unrelated: "keep" };
  const io = {
    read: () => parseAppConfig(raw),
    write: (patch: Record<string, unknown>) => {
      raw = { ...raw, theme: { ...raw.theme, ...(patch.theme as typeof raw.theme) } };
      return parseAppConfig(raw);
    },
  };
  const owner = createAppearanceOwner(io);
  owner.select("dracula");
  assert.equal(raw.unrelated, "keep");
  assert.equal(createAppearanceOwner(io).publication().selected, "dracula");
  owner.select("light");
  assert.equal(createAppearanceOwner(io).publication().selected, "light");
  const failing = createAppearanceOwner({
    read: io.read,
    write: () => {
      throw new Error("SECRET /private/path");
    },
  });
  const before = failing.publication();
  failing.select("nord");
  assert.deepEqual(failing.publication().theme, before.theme);
  assert.equal(failing.publication().selected, "light");
  assert.equal(failing.publication().error, "Could not save theme — try again");
  failing.select("unknown");
  assert.equal(failing.publication().selected, "light");
});

test("native default chrome stays neutral without changing canonical terminal colors", () => {
  const pack = (c: { red: number; green: number; blue: number }) =>
    (c.red << 16) | (c.green << 8) | c.blue;
  for (const selected of ["system", "light", "dark"]) {
    for (const system of ["light", "dark"] as const) {
      const light = selected === "light" || (selected === "system" && system === "light");
      const a = resolveNativeAppearance(selected, system).theme;
      const t = resolveVisualTheme({ appearance: light ? "light" : "dark" }).tokens;
      assert.equal(a.canvas, light ? 0xffffff : 0x181818);
      assert.equal(a.surface, light ? 0xf9f9f9 : 0x212121);
      assert.equal(a.active, light ? 0xe8e8e8 : 0x303030);
      assert.equal(a.background, pack(t.surfaces.terminal));
      assert.equal(a.foreground, pack(t.text.primary));
      assert.equal(a.cursor, pack(t.selection.hover));
      assert.equal(a.muted, pack(t.text.muted));
      assert.deepEqual(
        a.palette,
        createVisualTerminalPalette({
          foreground: pack(t.text.primary),
          background: pack(t.surfaces.terminal),
          danger: pack(t.statusTone.danger),
          success: pack(t.statusTone.success),
          warning: pack(t.statusTone.warning),
          link: pack(t.text.link),
          accent: pack(t.borders.focused),
          info: pack(t.statusTone.info),
          secondary: pack(t.text.secondary),
          muted: pack(t.text.muted),
          bright: pack(t.text.bright),
        }),
      );
    }
  }
  for (const preset of VISUAL_THEME_PRESETS) {
    const a = resolveNativeAppearance(preset.id, "dark").theme;
    const t = resolveVisualTheme({ userTheme: preset }).tokens;
    assert.equal(a.canvas, pack(t.surfaces.canvas));
    assert.equal(a.surface, pack(t.surfaces.panel));
    assert.equal(a.active, pack(t.selection.selection));
  }
});
