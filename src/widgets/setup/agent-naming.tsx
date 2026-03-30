import { createSignal, onMount } from "solid-js";
import { RGBA, TextAttributes, type InputRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import type { IdeConfig } from "../../schemas/ide-config.ts";
import type { WidgetTheme, RGBA as RGBAType } from "../lib/theme.ts";

function toRGBA(c: RGBAType): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
}

/** Extract titles of claude panes from an IdeConfig. */
function extractClaudePaneTitles(config: IdeConfig): string[] {
  const titles: string[] = [];
  for (const row of config.rows) {
    for (const pane of row.panes) {
      if (pane.command === "claude") {
        titles.push(pane.title ?? "Claude");
      }
    }
  }
  return titles;
}

interface AgentNamingProps {
  config: IdeConfig;
  onContinue: (names: string[]) => void;
  theme: WidgetTheme;
}

export function AgentNaming(props: AgentNamingProps) {
  const defaults = extractClaudePaneTitles(props.config);
  const theme = props.theme;

  // Create a signal per pane name
  const nameSignals = defaults.map((d) => createSignal(d));
  const [activeField, setActiveField] = createSignal(0);

  const inputRefs: (InputRenderable | undefined)[] = new Array(defaults.length).fill(undefined);

  onMount(() => {
    setTimeout(() => inputRefs[0]?.focus(), 50);
  });

  useKeyboard((evt) => {
    if (evt.name === "tab") {
      const next = (activeField() + 1) % nameSignals.length;
      setActiveField(next);
      setTimeout(() => inputRefs[next]?.focus(), 10);
      evt.preventDefault();
    } else if (evt.name === "return") {
      const names = nameSignals.map(([getter]) => getter());
      props.onContinue(names);
      evt.preventDefault();
    }
  });

  return (
    <box paddingLeft={1} paddingRight={1}>
      {/* Header */}
      <box flexShrink={0} paddingBottom={1}>
        <text fg={toRGBA(theme.accent)} attributes={TextAttributes.BOLD}>
          Name Your Agents
        </text>
        <text fg={toRGBA(theme.fgMuted)}>Customize the names for each Claude pane.</text>
      </box>

      {/* Input fields */}
      {nameSignals.map(([getter, setter], index) => {
        const isActive = () => activeField() === index;
        return (
          <box
            flexShrink={0}
            paddingBottom={1}
            onMouseDown={() => {
              setActiveField(index);
              setTimeout(() => inputRefs[index]?.focus(), 10);
            }}
          >
            <text fg={toRGBA(isActive() ? theme.accent : theme.fgMuted)}>Pane {index + 1}</text>
            <input
              value={getter()}
              placeholder={defaults[index] ?? "Agent"}
              onInput={(v: string) => setter(v)}
              focusedBackgroundColor={toRGBA(theme.selected)}
              cursorColor={toRGBA(theme.accent)}
              focusedTextColor={toRGBA(theme.fg)}
              ref={(r: InputRenderable) => {
                inputRefs[index] = r;
              }}
            />
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
          <text fg={toRGBA(theme.fgMuted)}>Tab:next field</text>
          <text fg={toRGBA(theme.fgMuted)}>Enter:continue</text>
        </box>
      </box>
    </box>
  );
}
