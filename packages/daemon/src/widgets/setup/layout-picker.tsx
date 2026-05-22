import { createSignal } from "solid-js";
import { RGBA, TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import type { LayoutPreset } from "./setup-model.ts";
import type { WidgetTheme, RGBA as RGBAType } from "../lib/theme.ts";

function toRGBA(c: RGBAType): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
}

interface LayoutPickerProps {
  presets: LayoutPreset[];
  onSelect: (preset: LayoutPreset) => void;
  theme: WidgetTheme;
}

export function LayoutPicker(props: LayoutPickerProps) {
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const theme = props.theme;

  useKeyboard((evt) => {
    if (evt.name === "k" || evt.name === "up") {
      setSelectedIndex((i) => Math.max(0, i - 1));
      evt.preventDefault();
    } else if (evt.name === "j" || evt.name === "down") {
      setSelectedIndex((i) => Math.min(props.presets.length - 1, i + 1));
      evt.preventDefault();
    } else if (evt.name === "return") {
      const preset = props.presets[selectedIndex()];
      if (preset) props.onSelect(preset);
      evt.preventDefault();
    }
  });

  return (
    <box paddingLeft={1} paddingRight={1}>
      {/* Header */}
      <box flexShrink={0} paddingBottom={1}>
        <text fg={toRGBA(theme.accent)} attributes={TextAttributes.BOLD}>
          Choose Layout
        </text>
      </box>

      {/* Preset options */}
      {props.presets.map((preset, index) => {
        const isSelected = () => selectedIndex() === index;
        return (
          <box
            flexShrink={0}
            paddingBottom={1}
            backgroundColor={isSelected() ? toRGBA(theme.selected) : undefined}
            onMouseDown={() => setSelectedIndex(index)}
            onMouseMove={() => setSelectedIndex(index)}
            onMouseUp={() => props.onSelect(preset)}
          >
            <box flexDirection="row" gap={1}>
              <text fg={toRGBA(isSelected() ? theme.accent : theme.fgMuted)}>
                {isSelected() ? "▸" : " "}
              </text>
              <text
                fg={toRGBA(isSelected() ? theme.accent : theme.fg)}
                attributes={isSelected() ? TextAttributes.BOLD : 0}
              >
                {preset.label}
              </text>
              <text fg={toRGBA(theme.fgMuted)}>— {preset.description}</text>
            </box>
            {isSelected() ? (
              <box paddingLeft={3}>
                {preset.diagram.map((line) => (
                  <text fg={toRGBA(theme.fg)}>{line}</text>
                ))}
              </box>
            ) : null}
          </box>
        );
      })}

      {/* Spacer */}
      <box flexGrow={1} />

      {/* Footer */}
      <box flexShrink={0}>
        <box flexShrink={0} height={1}>
          <text fg={toRGBA(theme.border)} wrapMode="none">
            {"─".repeat(40)}
          </text>
        </box>
        <box flexDirection="row" gap={2}>
          <text fg={toRGBA(theme.fgMuted)}>j/k:navigate</text>
          <text fg={toRGBA(theme.fgMuted)}>Enter:select</text>
        </box>
      </box>
    </box>
  );
}
