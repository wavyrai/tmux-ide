import { createSignal, onMount } from "solid-js";
import { RGBA, TextAttributes, type InputRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import type { WidgetTheme, RGBA as RGBAType } from "../lib/theme.ts";

function toRGBA(c: RGBAType): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
}

interface CommandBarProps {
  value: string;
  isActive: boolean;
  theme: WidgetTheme;
  onSubmit: (value: string) => void;
  onChange: (value: string) => void;
  onEscape: () => void;
}

export function CommandBar(props: CommandBarProps) {
  let inputRef: InputRenderable | undefined;

  onMount(() => {
    if (props.isActive) {
      setTimeout(() => inputRef?.focus(), 50);
    }
  });

  useKeyboard((evt) => {
    if (!props.isActive) return;

    if (evt.name === "escape") {
      props.onEscape();
      evt.preventDefault();
    } else if (evt.name === "return") {
      if (props.value.trim()) {
        props.onSubmit(props.value);
      }
      evt.preventDefault();
    }
  });

  return (
    <box flexDirection="row" gap={1}>
      <text
        fg={toRGBA(props.isActive ? props.theme.accent : props.theme.fgMuted)}
        attributes={props.isActive ? TextAttributes.BOLD : 0}
      >
        {">"}
      </text>
      <input
        value={props.value}
        placeholder={props.isActive ? "task create, send, goal, add..." : "press / to type"}
        onInput={(v: string) => props.onChange(v)}
        focusedBackgroundColor={toRGBA(props.theme.selected)}
        cursorColor={toRGBA(props.theme.accent)}
        focusedTextColor={toRGBA(props.theme.fg)}
        ref={(r: InputRenderable) => {
          inputRef = r;
        }}
      />
    </box>
  );
}
