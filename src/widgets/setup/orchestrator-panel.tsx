import { createSignal, For } from "solid-js";
import { RGBA, TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import type { WidgetTheme, RGBA as RGBAType } from "../lib/theme.ts";

function toRGBA(c: RGBAType): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
}

export interface OrchestratorPanelConfig {
  enabled: boolean;
  auto_dispatch: boolean;
  master_pane: string | null;
}

interface OrchestratorPanelProps {
  claudePaneNames: string[];
  theme: WidgetTheme;
  onContinue: (config: OrchestratorPanelConfig) => void;
  onBack: () => void;
}

type Field = "enabled" | "master_pane" | "auto_dispatch" | "confirm";

export function OrchestratorPanel(props: OrchestratorPanelProps) {
  const [enabled, setEnabled] = createSignal(true);
  const [autoDispatch, setAutoDispatch] = createSignal(true);
  const [masterIdx, setMasterIdx] = createSignal(0);
  const [activeField, setActiveField] = createSignal<Field>("enabled");

  const theme = props.theme;

  const fields: Field[] = ["enabled", "master_pane", "auto_dispatch", "confirm"];

  function fieldIndex() {
    return fields.indexOf(activeField());
  }

  useKeyboard((evt) => {
    if (evt.name === "escape") {
      props.onBack();
      evt.preventDefault();
      return;
    }

    if (evt.name === "down" || evt.name === "j") {
      const next = Math.min(fieldIndex() + 1, fields.length - 1);
      setActiveField(fields[next]!);
      evt.preventDefault();
    } else if (evt.name === "up" || evt.name === "k") {
      const prev = Math.max(fieldIndex() - 1, 0);
      setActiveField(fields[prev]!);
      evt.preventDefault();
    } else if (evt.name === "space" || evt.name === "return") {
      const field = activeField();
      if (field === "enabled") {
        setEnabled(!enabled());
      } else if (field === "master_pane" && props.claudePaneNames.length > 0) {
        setMasterIdx((masterIdx() + 1) % props.claudePaneNames.length);
      } else if (field === "auto_dispatch") {
        setAutoDispatch(!autoDispatch());
      } else if (field === "confirm") {
        props.onContinue({
          enabled: enabled(),
          auto_dispatch: autoDispatch(),
          master_pane: props.claudePaneNames[masterIdx()] ?? null,
        });
      }
      evt.preventDefault();
    }
  });

  function toggleLabel(active: boolean): string {
    return active ? "[x]" : "[ ]";
  }

  function isActive(field: Field): boolean {
    return activeField() === field;
  }

  return (
    <box paddingLeft={1} paddingRight={1}>
      {/* Header */}
      <box flexShrink={0} paddingBottom={1}>
        <text fg={toRGBA(theme.accent)} attributes={TextAttributes.BOLD}>
          Orchestrator Configuration
        </text>
        <text fg={toRGBA(theme.fgMuted)}>
          Configure multi-agent orchestration for your team layout.
        </text>
      </box>

      {/* Enabled toggle */}
      <box
        flexShrink={0}
        flexDirection="row"
        gap={1}
        paddingBottom={1}
        onMouseDown={() => {
          setActiveField("enabled");
          setEnabled(!enabled());
        }}
      >
        <text
          fg={toRGBA(isActive("enabled") ? theme.accent : theme.fg)}
          attributes={isActive("enabled") ? TextAttributes.BOLD : undefined}
        >
          {isActive("enabled") ? ">" : " "} {toggleLabel(enabled())} Enabled
        </text>
      </box>

      {/* Master pane picker */}
      <box flexShrink={0} paddingBottom={1}>
        <text
          fg={toRGBA(isActive("master_pane") ? theme.accent : theme.fg)}
          attributes={isActive("master_pane") ? TextAttributes.BOLD : undefined}
        >
          {isActive("master_pane") ? ">" : " "} Master Pane
        </text>
        <box paddingLeft={4}>
          <For each={props.claudePaneNames}>
            {(name, i) => (
              <text
                fg={toRGBA(i() === masterIdx() ? theme.accent : theme.fgMuted)}
                onMouseDown={() => {
                  setActiveField("master_pane");
                  setMasterIdx(i());
                }}
              >
                {i() === masterIdx() ? "● " : "○ "}
                {name}
              </text>
            )}
          </For>
        </box>
        <box paddingLeft={4}>
          <text fg={toRGBA(theme.fgMuted)}>Space/Enter to cycle selection</text>
        </box>
      </box>

      {/* Auto dispatch toggle */}
      <box
        flexShrink={0}
        flexDirection="row"
        gap={1}
        paddingBottom={1}
        onMouseDown={() => {
          setActiveField("auto_dispatch");
          setAutoDispatch(!autoDispatch());
        }}
      >
        <text
          fg={toRGBA(isActive("auto_dispatch") ? theme.accent : theme.fg)}
          attributes={isActive("auto_dispatch") ? TextAttributes.BOLD : undefined}
        >
          {isActive("auto_dispatch") ? ">" : " "} {toggleLabel(autoDispatch())} Auto-dispatch tasks
        </text>
      </box>

      {/* Spacer */}
      <box flexGrow={1} />

      {/* Continue button */}
      <box
        flexShrink={0}
        paddingBottom={1}
        onMouseDown={() => {
          setActiveField("confirm");
          props.onContinue({
            enabled: enabled(),
            auto_dispatch: autoDispatch(),
            master_pane: props.claudePaneNames[masterIdx()] ?? null,
          });
        }}
      >
        <text
          fg={toRGBA(isActive("confirm") ? theme.accent : theme.fgMuted)}
          attributes={isActive("confirm") ? TextAttributes.BOLD : undefined}
        >
          {isActive("confirm") ? ">" : " "} [ Continue → ]
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
          <text fg={toRGBA(theme.fgMuted)}>j/k:navigate</text>
          <text fg={toRGBA(theme.fgMuted)}>Space:toggle</text>
          <text fg={toRGBA(theme.fgMuted)}>Enter:select</text>
          <text fg={toRGBA(theme.fgMuted)}>Esc:back</text>
        </box>
      </box>
    </box>
  );
}
