import { createSignal, createMemo, Show } from "solid-js";
import { RGBA, TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import yaml from "js-yaml";
import type { IdeConfig } from "../../schemas/ide-config.ts";
import { validateConfig } from "../../validate.ts";
import { writeConfig } from "../../lib/yaml-io.ts";
import type { WidgetTheme, RGBA as RGBAType } from "../lib/theme.ts";

function toRGBA(c: RGBAType): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
}

export type ReviewAction = "write" | "launch";

interface ReviewPanelProps {
  config: IdeConfig;
  dir: string;
  theme: WidgetTheme;
  onDone: (action: ReviewAction) => void;
  onBack: () => void;
}

export function ReviewPanel(props: ReviewPanelProps) {
  const [selectedAction, setSelectedAction] = createSignal<0 | 1>(0);

  const theme = props.theme;

  const yamlPreview = createMemo(() =>
    yaml.dump(props.config, { lineWidth: -1, noRefs: true, quotingType: '"' }),
  );

  const errors = createMemo(() => validateConfig(props.config));
  const isValid = createMemo(() => errors().length === 0);

  useKeyboard((evt) => {
    if (evt.name === "escape") {
      props.onBack();
      evt.preventDefault();
      return;
    }

    if (evt.name === "j" || evt.name === "down" || evt.name === "tab") {
      setSelectedAction((prev) => (prev === 0 ? 1 : 0) as 0 | 1);
      evt.preventDefault();
    } else if (evt.name === "k" || evt.name === "up") {
      setSelectedAction((prev) => (prev === 0 ? 1 : 0) as 0 | 1);
      evt.preventDefault();
    } else if (evt.name === "return") {
      if (!isValid()) return;
      writeConfig(props.dir, props.config);
      props.onDone(selectedAction() === 0 ? "write" : "launch");
      evt.preventDefault();
    }
  });

  return (
    <box paddingLeft={1} paddingRight={1}>
      {/* Header */}
      <box flexShrink={0} paddingBottom={1}>
        <text fg={toRGBA(theme.accent)} attributes={TextAttributes.BOLD}>
          Review Configuration
        </text>
      </box>

      {/* YAML preview */}
      <box flexGrow={1} flexShrink={1}>
        <text fg={toRGBA(theme.fgMuted)} attributes={TextAttributes.BOLD}>
          ide.yml preview:
        </text>
        <scrollbox>
          <text fg={toRGBA(theme.fg)}>{yamlPreview()}</text>
        </scrollbox>
      </box>

      {/* Validation status */}
      <box flexShrink={0} paddingTop={1} paddingBottom={1}>
        <Show
          when={isValid()}
          fallback={
            <box>
              <text fg={RGBA.fromInts(255, 80, 80, 255)} attributes={TextAttributes.BOLD}>
                Validation errors:
              </text>
              {errors().map((e) => (
                <text fg={RGBA.fromInts(255, 80, 80, 255)}> - {e}</text>
              ))}
            </box>
          }
        >
          <text fg={toRGBA(theme.gitAdded)} attributes={TextAttributes.BOLD}>
            Config is valid
          </text>
        </Show>
      </box>

      {/* Action buttons */}
      <box flexShrink={0} paddingBottom={1}>
        <text
          fg={toRGBA(selectedAction() === 0 ? theme.accent : theme.fgMuted)}
          attributes={selectedAction() === 0 ? TextAttributes.BOLD : undefined}
          onMouseDown={() => setSelectedAction(0)}
          onMouseUp={() => {
            if (!isValid()) return;
            writeConfig(props.dir, props.config);
            props.onDone("write");
          }}
        >
          {selectedAction() === 0 ? ">" : " "} [ Write ide.yml ]
        </text>
        <text
          fg={toRGBA(selectedAction() === 1 ? theme.accent : theme.fgMuted)}
          attributes={selectedAction() === 1 ? TextAttributes.BOLD : undefined}
          onMouseDown={() => setSelectedAction(1)}
          onMouseUp={() => {
            if (!isValid()) return;
            writeConfig(props.dir, props.config);
            props.onDone("launch");
          }}
        >
          {selectedAction() === 1 ? ">" : " "} [ Write & Launch ]
        </text>
      </box>

      {/* Footer */}
      <box flexShrink={0}>
        <box flexShrink={0} height={1}>
          <text fg={toRGBA(theme.border)} wrapMode="none">
            {"─".repeat(40)}
          </text>
        </box>
        <box flexDirection="row" gap={2}>
          <text fg={toRGBA(theme.fgMuted)}>j/k:select action</text>
          <text fg={toRGBA(theme.fgMuted)}>Enter:confirm</text>
          <text fg={toRGBA(theme.fgMuted)}>Esc:back</text>
        </box>
      </box>
    </box>
  );
}
