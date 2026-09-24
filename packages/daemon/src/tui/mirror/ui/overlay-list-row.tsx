/* @jsxImportSource @opentui/solid */
import { For, createMemo } from "solid-js";
import { fuzzyTermsMatch as commandSearchMatch } from "../../team/fuzzy.ts";
import type { SemanticThemeSnapshot } from "../theme.ts";
import { clipTerminal, terminalDisplayWidth } from "../terminal-text.ts";
import { overlayRowPalette } from "./overlay-surface.ts";
import { componentPalette } from "./state.ts";

export interface OverlayListRowProps {
  readonly theme: SemanticThemeSnapshot;
  readonly id: string;
  readonly label: string;
  readonly query?: string;
  readonly surface?: boolean;
  readonly width: number;
  readonly shortcut?: string;
  readonly selected?: boolean;
  /** When provided, mark the committed value independently of the selection. */
  readonly current?: boolean;
  readonly disabled?: boolean;
  readonly danger?: boolean;
  /** Fixed selection gutter for menus; compact palette callers retain their budget. */
  readonly reserveMarker?: boolean;
  readonly onHighlight?: () => void;
  readonly onPress: () => void;
}

export function OverlayListRow(props: OverlayListRowProps) {
  const palette = () =>
    props.surface
      ? overlayRowPalette(props.theme, {
          selected: props.selected,
          disabled: props.disabled,
          attention: props.danger,
        })
      : componentPalette(
          props.theme,
          { selected: props.selected, disabled: props.disabled, attention: props.danger },
          props.danger ? "blocked" : "neutral",
        );
  const content = () => {
    const prefix =
      props.current !== undefined
        ? props.current
          ? "● "
          : "  "
        : props.selected
          ? props.surface
            ? "  "
            : "› "
          : props.reserveMarker
            ? "  "
            : "";
    const shortcut =
      props.shortcut &&
      props.width >=
        terminalDisplayWidth(prefix) +
          terminalDisplayWidth(props.label) +
          terminalDisplayWidth(props.shortcut) +
          2
        ? ` ${props.shortcut}`
        : "";
    const available = Math.max(
      1,
      props.width - terminalDisplayWidth(prefix) - terminalDisplayWidth(shortcut),
    );
    const label = clipTerminal(props.label, available);
    const gap = Math.max(
      0,
      props.width -
        terminalDisplayWidth(prefix) -
        terminalDisplayWidth(label) -
        terminalDisplayWidth(shortcut),
    );
    return { body: clipTerminal(`${prefix}${label}${" ".repeat(gap)}`, props.width), shortcut };
  };
  const segments = createMemo(() => {
    const value = content().body;
    const matches = new Set(
      props.query ? (commandSearchMatch(value, props.query)?.indices ?? []) : [],
    );
    const runs: { text: string; match: boolean }[] = [];
    for (const [index, character] of Array.from(value).entries()) {
      const match = matches.has(index);
      const previous = runs.at(-1);
      if (previous?.match === match) previous.text += character;
      else runs.push({ text: character, match });
    }
    return runs;
  });
  return (
    <text
      id={`ui-overlay-row:${props.id}`}
      width={props.width}
      height={1}
      overflow="hidden"
      fg={palette().foreground}
      bg={palette().background}
      onMouseOver={() => {
        if (!props.disabled) props.onHighlight?.();
      }}
      onMouseMove={() => {
        if (!props.disabled) props.onHighlight?.();
      }}
      onMouseDown={(event) => {
        if (event.button !== 0 || props.disabled) return;
        event.preventDefault();
        event.stopPropagation();
        props.onPress();
      }}
    >
      <For each={segments()}>
        {(segment) =>
          segment.match ? (
            <strong>
              <u>{segment.text}</u>
            </strong>
          ) : (
            segment.text
          )
        }
      </For>
      <span
        style={{
          fg:
            props.selected && !props.disabled ? palette().foreground : props.theme.roles.text.muted,
        }}
      >
        {content().shortcut}
      </span>
    </text>
  );
}
