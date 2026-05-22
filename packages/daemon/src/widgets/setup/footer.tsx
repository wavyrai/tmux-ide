import { RGBA, TextAttributes } from "@opentui/core";
import type { WidgetTheme, RGBA as RGBAType } from "../lib/theme.ts";

function toRGBA(c: RGBAType): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
}

export type ViewKind =
  | "detect"
  | "layout-picker"
  | "agent-naming"
  | "orchestrator"
  | "review"
  | "editor-tree"
  | "editor-field";

export interface FooterActions {
  onConfirm?: () => void;
  onBack?: () => void;
  onQuit?: () => void;
  onAdd?: () => void;
  onDelete?: () => void;
  onSave?: () => void;
}

interface FooterProps {
  viewKind: ViewKind;
  theme: WidgetTheme;
  actions?: FooterActions;
}

interface HintDef {
  label: string;
  actionKey?: keyof FooterActions;
}

const VIEW_HINTS: Record<ViewKind, HintDef[]> = {
  detect: [
    { label: "Enter:continue", actionKey: "onConfirm" },
    { label: "q:quit", actionKey: "onQuit" },
  ],
  "layout-picker": [
    { label: "j/k:navigate" },
    { label: "Enter:select", actionKey: "onConfirm" },
    { label: "q:quit", actionKey: "onQuit" },
  ],
  "agent-naming": [
    { label: "Tab:next field" },
    { label: "Enter:continue", actionKey: "onConfirm" },
    { label: "Esc:back", actionKey: "onBack" },
    { label: "q:quit", actionKey: "onQuit" },
  ],
  orchestrator: [
    { label: "Space:toggle" },
    { label: "Enter:continue", actionKey: "onConfirm" },
    { label: "Esc:back", actionKey: "onBack" },
    { label: "q:quit", actionKey: "onQuit" },
  ],
  review: [
    { label: "Enter:confirm", actionKey: "onConfirm" },
    { label: "Esc:back", actionKey: "onBack" },
    { label: "q:quit", actionKey: "onQuit" },
  ],
  "editor-tree": [
    { label: "j/k:nav" },
    { label: "Enter:edit", actionKey: "onConfirm" },
    { label: "a:add pane", actionKey: "onAdd" },
    { label: "d:delete", actionKey: "onDelete" },
    { label: "Ctrl+S:save", actionKey: "onSave" },
    { label: "q:quit", actionKey: "onQuit" },
  ],
  "editor-field": [
    { label: "Enter:save", actionKey: "onConfirm" },
    { label: "Esc:cancel", actionKey: "onBack" },
  ],
};

export function Footer(props: FooterProps) {
  const theme = props.theme;
  const hints = () => VIEW_HINTS[props.viewKind] ?? [];

  return (
    <box flexShrink={0}>
      <box flexShrink={0} height={1}>
        <text fg={toRGBA(theme.border)} wrapMode="none">
          {"─".repeat(60)}
        </text>
      </box>
      <box flexDirection="row" gap={2}>
        {hints().map((hint) => {
          const handler = hint.actionKey ? props.actions?.[hint.actionKey] : undefined;
          const isClickable = !!handler;
          return (
            <text
              fg={toRGBA(isClickable ? theme.fg : theme.fgMuted)}
              attributes={isClickable ? TextAttributes.UNDERLINE : 0}
              wrapMode="none"
              onMouseDown={handler ? () => handler() : undefined}
            >
              {hint.label}
            </text>
          );
        })}
      </box>
    </box>
  );
}
