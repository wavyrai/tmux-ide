/* @jsxImportSource @opentui/solid */
import { createSignal } from "solid-js";
import type { SemanticThemeSnapshot } from "../theme.ts";
import { clipTerminalEnd } from "../terminal-text.ts";
import { useKeyboardRoute, usePasteRoute, type RoutedKeyboardEvent } from "./keyboard-router.tsx";

/** Editing is local to Home; the resident fleet owner owns query and selected identity. */
export function HomeAgentSearch(props: {
  theme: SemanticThemeSnapshot;
  width: number;
  query: string;
  active: boolean;
  onChange: (query: string) => void;
  onEdit: (event: RoutedKeyboardEvent) => void;
  onPaste: (bytes: Uint8Array) => void;
  onEditing: (editing: boolean) => void;
  onSubmit: () => void;
}) {
  const [editing, setEditing] = createSignal(false);
  const edit = (value: boolean) => {
    setEditing(value);
    props.onEditing(value);
  };
  useKeyboardRoute((event) => {
    if (!props.active || event.eventType === "release") return false;
    const key = event.name.toLowerCase();
    if (!editing()) {
      if (key !== "/" || event.ctrl || event.meta) return false;
      edit(true);
    } else {
      if (["up", "down", "pageup", "pagedown", "home", "end"].includes(key)) return false;
      if (/^f\d+$/.test(key) || event.meta || (event.ctrl && key !== "u")) return false;
      if (key === "escape") {
        if (props.query) props.onChange("");
        else edit(false);
      } else if (key === "enter" || key === "return") {
        if (event.eventType !== "repeat") props.onSubmit();
      } else if (key === "tab") edit(false);
      else props.onEdit(event);
    }
    event.preventDefault();
    event.stopPropagation();
    return true;
  });
  usePasteRoute((bytes) => {
    if (!props.active || !editing()) return false;
    props.onPaste(bytes);
    return true;
  });
  return (
    <box
      width={props.width}
      height={1}
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={props.theme.roles.surfaces.panel}
      onMouseDown={(event) => {
        if (!props.active || event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        edit(true);
      }}
    >
      <text
        height={1}
        width={Math.max(0, props.width - 2)}
        fg={props.query ? props.theme.roles.text.primary : props.theme.roles.text.muted}
      >
        {clipTerminalEnd(
          props.query
            ? `${props.query}${editing() && props.active ? "▏" : ""}`
            : editing() && props.active
              ? "▏Find an agent or workspace"
              : "/  Find an agent or workspace",
          Math.max(0, props.width - 2),
        )}
      </text>
    </box>
  );
}
