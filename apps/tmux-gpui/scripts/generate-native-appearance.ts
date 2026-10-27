// Build-time bridge only: native runtime embeds the canonical resolved palettes.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { appearanceOptions, resolveNativeAppearance } from "../bridge/appearance.ts";
import { findVisualThemePreset } from "@tmux-ide/contracts";
const destination = new URL(
  "../upstream/crates/tmux-ide-gpui/src/tmux_snapshot/appearance/catalog.json",
  import.meta.url,
);
const entries = appearanceOptions.map(({ id, name }) => ({
  id,
  name,
  mode: findVisualThemePreset(id)?.appearance ?? id,
  dark: resolveNativeAppearance(id, "dark").theme,
  light: resolveNativeAppearance(id, "light").theme,
}));
const content = `[\n${entries.map((entry) => JSON.stringify(entry)).join(",\n")}\n]\n`;
if (process.argv.includes("--check"))
  assert.equal(
    readFileSync(destination, "utf8"),
    content,
    "Native palette is stale; regenerate with generate-native-appearance.ts",
  );
else writeFileSync(destination, content);
