/**
 * The shared `?` help overlay — one box, every surface.
 *
 * Renders the UNIVERSAL interaction grammar (from {@link GRAMMAR_HELP}, the same
 * constant the cheat sheet reads) above the caller's OWN widget-specific keys.
 * Because the grammar rows come from `grammar.ts`, no surface can document
 * `j`/`k`/`enter`/`/`/`esc`/`q`/`?` differently from how it behaves.
 *
 * Each surface keeps a `helpOpen` signal, routes `?` (grammar `help`) to toggle
 * it and `esc`/`q` to close it, and renders `<HelpOverlay …>` in place of its
 * body while open. Kept theme-driven and io-free so it drops into any widget.
 */
import { For, Show } from "solid-js";
import { RGBA, TextAttributes } from "@opentui/core";
import type { WidgetTheme } from "./theme.ts";
import { GRAMMAR_HELP } from "./grammar.ts";

function toRGBA(c: { r: number; g: number; b: number; a: number }): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
}

/** A widget-specific key row: the rendered key(s) and what they do. */
export interface WidgetKey {
  key: string;
  label: string;
}

export interface HelpOverlayProps {
  theme: WidgetTheme;
  /** Surface name shown in the header (e.g. "explorer", "sidebar"). */
  title: string;
  /** The surface's own keys, listed under the shared grammar. */
  widgetKeys: WidgetKey[];
}

/**
 * A centered help card: a "grammar" section (shared verbs) then a section of
 * the surface's own keys. Replaces the surface body while `?` is held open;
 * `esc`/`q`/`?` close it.
 */
export function HelpOverlay(props: HelpOverlayProps) {
  const keyCol = () => {
    const widths = [
      ...GRAMMAR_HELP.map((r) => r.keys.length),
      ...props.widgetKeys.map((r) => r.key.length),
    ];
    return Math.max(6, ...widths);
  };
  return (
    <box flexDirection="column" flexGrow={1} alignItems="center" paddingTop={2}>
      <box
        flexDirection="column"
        border
        borderColor={toRGBA(props.theme.accent)}
        backgroundColor={toRGBA(props.theme.selected)}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
      >
        <text fg={toRGBA(props.theme.accent)} attributes={TextAttributes.BOLD}>
          {props.title} — help
        </text>

        <box paddingTop={1}>
          <text fg={toRGBA(props.theme.fgMuted)} attributes={TextAttributes.BOLD}>
            grammar
          </text>
        </box>
        <For each={GRAMMAR_HELP}>
          {(row) => (
            <box flexDirection="row" gap={1}>
              <text fg={toRGBA(props.theme.accent)}>{row.keys.padEnd(keyCol())}</text>
              <text fg={toRGBA(props.theme.fg)}>{row.label}</text>
            </box>
          )}
        </For>

        <Show when={props.widgetKeys.length > 0}>
          <box paddingTop={1}>
            <text fg={toRGBA(props.theme.fgMuted)} attributes={TextAttributes.BOLD}>
              {props.title}
            </text>
          </box>
          <For each={props.widgetKeys}>
            {(row) => (
              <box flexDirection="row" gap={1}>
                <text fg={toRGBA(props.theme.accent)}>{row.key.padEnd(keyCol())}</text>
                <text fg={toRGBA(props.theme.fg)}>{row.label}</text>
              </box>
            )}
          </For>
        </Show>

        <box paddingTop={1}>
          <text fg={toRGBA(props.theme.fgMuted)}>esc / q / ? to close</text>
        </box>
      </box>
    </box>
  );
}
