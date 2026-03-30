import { createSignal, onMount } from "solid-js";
import { RGBA, TextAttributes, type InputRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import type { WidgetTheme, RGBA as RGBAType } from "../lib/theme.ts";

function toRGBA(c: RGBAType): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
}

export type FieldType = "string" | "enum" | "boolean" | "size";

export interface FieldEditorProps {
  path: string[];
  value: string;
  fieldType: FieldType;
  enumValues?: string[];
  onSave: (path: string[], newValue: unknown) => void;
  onCancel: () => void;
  theme: WidgetTheme;
}

/** Validate a size string (e.g. "70%", "50%"). */
function isValidSize(v: string): boolean {
  return /^\d{1,3}%$/.test(v);
}

// ---------------------------------------------------------------------------
// String / Size editor (input-based)
// ---------------------------------------------------------------------------

function StringEditor(props: {
  value: string;
  isSize: boolean;
  onSave: (v: string) => void;
  onCancel: () => void;
  theme: WidgetTheme;
}) {
  const [text, setText] = createSignal(props.value);
  const [error, setError] = createSignal<string | null>(null);
  let inputRef: InputRenderable | undefined;

  onMount(() => {
    setTimeout(() => inputRef?.focus(), 50);
  });

  useKeyboard((evt) => {
    if (evt.name === "escape") {
      props.onCancel();
      evt.preventDefault();
    } else if (evt.name === "return") {
      const val = text();
      if (props.isSize && !isValidSize(val)) {
        setError("Must be a percentage (e.g. 70%)");
        return;
      }
      props.onSave(val);
      evt.preventDefault();
    }
  });

  return (
    <box>
      <input
        value={text()}
        placeholder={props.isSize ? "e.g. 70%" : "Enter value..."}
        onInput={(v: string) => {
          setText(v);
          setError(null);
        }}
        focusedBackgroundColor={toRGBA(props.theme.selected)}
        cursorColor={toRGBA(props.theme.accent)}
        focusedTextColor={toRGBA(props.theme.fg)}
        onMouseDown={() => inputRef?.focus()}
        ref={(r: InputRenderable) => {
          inputRef = r;
        }}
      />
      {error() ? <text fg={toRGBA(props.theme.gitDeleted)}>{error()}</text> : null}
    </box>
  );
}

// ---------------------------------------------------------------------------
// Enum editor (list selection)
// ---------------------------------------------------------------------------

function EnumEditor(props: {
  value: string;
  values: string[];
  onSave: (v: string) => void;
  onCancel: () => void;
  theme: WidgetTheme;
}) {
  const initial = Math.max(0, props.values.indexOf(props.value));
  const [selectedIndex, setSelectedIndex] = createSignal(initial);
  const [inputMode, setInputMode] = createSignal<"keyboard" | "mouse">("keyboard");

  useKeyboard((evt) => {
    setInputMode("keyboard");
    if (evt.name === "escape") {
      props.onCancel();
      evt.preventDefault();
    } else if (evt.name === "k" || evt.name === "up") {
      setSelectedIndex((i) => Math.max(0, i - 1));
      evt.preventDefault();
    } else if (evt.name === "j" || evt.name === "down") {
      setSelectedIndex((i) => Math.min(props.values.length - 1, i + 1));
      evt.preventDefault();
    } else if (evt.name === "return") {
      const val = props.values[selectedIndex()];
      if (val !== undefined) props.onSave(val);
      evt.preventDefault();
    }
  });

  return (
    <box>
      {props.values.map((val, index) => {
        const isSelected = () => selectedIndex() === index;
        return (
          <box
            flexShrink={0}
            backgroundColor={isSelected() ? toRGBA(props.theme.selected) : undefined}
            onMouseMove={() => {
              setInputMode("mouse");
              setSelectedIndex(index);
            }}
            onMouseDown={() => setSelectedIndex(index)}
            onMouseUp={() => props.onSave(val)}
          >
            <text
              fg={toRGBA(isSelected() ? props.theme.accent : props.theme.fg)}
              attributes={isSelected() ? TextAttributes.BOLD : 0}
            >
              {isSelected() ? "▸ " : "  "}
              {val}
            </text>
          </box>
        );
      })}
    </box>
  );
}

// ---------------------------------------------------------------------------
// Boolean editor (toggle)
// ---------------------------------------------------------------------------

function BooleanEditor(props: {
  value: string;
  onSave: (v: boolean) => void;
  onCancel: () => void;
  theme: WidgetTheme;
}) {
  const [val, setVal] = createSignal(props.value === "true");

  useKeyboard((evt) => {
    if (evt.name === "escape") {
      props.onCancel();
      evt.preventDefault();
    } else if (evt.name === "space") {
      setVal((v) => !v);
      evt.preventDefault();
    } else if (evt.name === "return") {
      props.onSave(val());
      evt.preventDefault();
    }
  });

  return (
    <box flexDirection="row" gap={1}>
      <text
        fg={toRGBA(props.theme.accent)}
        attributes={TextAttributes.BOLD}
        onMouseUp={() => setVal((v) => !v)}
      >
        {val() ? "[x]" : "[ ]"}
      </text>
      <text fg={toRGBA(props.theme.fg)} onMouseUp={() => setVal((v) => !v)}>
        {val() ? "true" : "false"}
      </text>
      <text fg={toRGBA(props.theme.fgMuted)}>(Space to toggle, click to flip)</text>
    </box>
  );
}

// ---------------------------------------------------------------------------
// Main FieldEditor
// ---------------------------------------------------------------------------

export function FieldEditor(props: FieldEditorProps) {
  const theme = props.theme;
  const pathLabel = props.path.join(".");

  return (
    <box paddingLeft={1} paddingRight={1}>
      {/* Header */}
      <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingBottom={1}>
        <text fg={toRGBA(theme.accent)} attributes={TextAttributes.BOLD}>
          Edit: {pathLabel}
        </text>
        <text fg={toRGBA(theme.fgMuted)} onMouseUp={() => props.onCancel()}>
          Esc:cancel
        </text>
      </box>

      {/* Current value */}
      <box flexShrink={0} paddingBottom={1}>
        <text fg={toRGBA(theme.fgMuted)}>Current: {props.value || "(empty)"}</text>
      </box>

      {/* Editor */}
      <box flexShrink={0} paddingBottom={1}>
        {props.fieldType === "enum" ? (
          <EnumEditor
            value={props.value}
            values={props.enumValues ?? []}
            onSave={(v) => props.onSave(props.path, v)}
            onCancel={props.onCancel}
            theme={theme}
          />
        ) : props.fieldType === "boolean" ? (
          <BooleanEditor
            value={props.value}
            onSave={(v) => props.onSave(props.path, v)}
            onCancel={props.onCancel}
            theme={theme}
          />
        ) : (
          <StringEditor
            value={props.value}
            isSize={props.fieldType === "size"}
            onSave={(v) => props.onSave(props.path, v)}
            onCancel={props.onCancel}
            theme={theme}
          />
        )}
      </box>

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
          {props.fieldType === "enum" ? (
            <text fg={toRGBA(theme.fgMuted)}>j/k:navigate Enter:select</text>
          ) : props.fieldType === "boolean" ? (
            <text fg={toRGBA(theme.fgMuted)}>Space:toggle Enter:confirm</text>
          ) : (
            <text fg={toRGBA(theme.fgMuted)}>Enter:save</text>
          )}
          <text fg={toRGBA(theme.fgMuted)} onMouseUp={() => props.onCancel()}>
            Esc:cancel
          </text>
        </box>
      </box>
    </box>
  );
}
