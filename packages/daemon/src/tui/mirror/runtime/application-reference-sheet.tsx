/* @jsxImportSource @opentui/solid */
import { createSignal, For, Show } from "solid-js";
import type { SemanticThemeSnapshot } from "../theme.ts";
import { Dialog } from "../ui/dialog.tsx";
import { DetailRow } from "../ui/detail-row.tsx";
import { OverlaySearchField } from "../ui/overlay-search-field.tsx";
import { overlaySurfaceMetrics } from "../ui/overlay-model.ts";
import { useKeyboardRoute, usePasteRoute } from "../ui/keyboard-router.tsx";
import { clipTerminal, terminalDisplayWidth } from "../terminal-text.ts";
import { APPLICATION_SHORTCUTS } from "../workspace/application-shortcuts.ts";
import { commandSearchMatch } from "../workspace/application-command-description.ts";
import {
  applicationPaneRenameKeyAction,
  applicationPaneRenamePaste,
} from "./application-pane-rename-input.ts";

const releases = [
  {
    version: "2.9.0-beta.30",
    lines: [
      "A calmer Home with agents across your machines.",
      "Search agents and filter by machine or attention.",
      "Hide or show the sidebar through Commands.",
      "Quieter status and navigation surfaces.",
    ],
  },
  {
    version: "2.9.0-beta.29",
    lines: [
      "Borderless Commands and Themes with clear sections.",
      "Full-width search and right-aligned shortcuts.",
      "Sessions uses the same flow from Commands and F6.",
      "Theme previews restore the previous theme on Escape.",
    ],
  },
  {
    version: "2.9.0-beta.18",
    lines: [
      "Fleet session previews, favorites and recent sessions.",
      "Create and close sessions on the selected host.",
    ],
  },
];
type Row = { kind: "heading" | "text" | "action" | "gap"; label: string; detail?: string };

export function ApplicationReferenceSheet(props: {
  page: "shortcuts" | "changes";
  width: number;
  height: number;
  theme: SemanticThemeSnapshot;
  onClose: () => void;
}) {
  const [page, setPage] = createSignal(props.page);
  const [offset, setOffset] = createSignal(0);
  const [query, setQuery] = createSignal("");
  const metrics = () =>
    overlaySurfaceMetrics({
      viewportWidth: props.width,
      viewportHeight: props.height,
      preferredWidth: 88,
      preferredHeight: 32,
    });
  const capacity = () => Math.max(0, metrics().contentHeight - (page() === "shortcuts" ? 5 : 3));
  const rows = (): Row[] => {
    const result: Row[] = [];
    if (page() === "shortcuts") {
      const entries = APPLICATION_SHORTCUTS.filter((entry) =>
        commandSearchMatch(`${entry.label} ${entry.keys} ${entry.category}`, query()),
      );
      for (const category of new Set(entries.map((entry) => entry.category))) {
        if (result.length) result.push({ kind: "gap", label: "" });
        result.push({ kind: "heading", label: category });
        result.push(
          ...entries
            .filter((entry) => entry.category === category)
            .map((entry) => ({ kind: "action" as const, label: entry.label, detail: entry.keys })),
        );
      }
      if (!result.length) result.push({ kind: "text", label: "No matching shortcuts" });
    } else {
      for (const release of releases) {
        if (result.length) result.push({ kind: "gap", label: "" });
        result.push({ kind: "heading", label: release.version });
        for (const line of release.lines) {
          let current = "";
          for (const word of line.split(" ")) {
            if (current && terminalDisplayWidth(`${current} ${word}`) > metrics().contentWidth) {
              result.push({ kind: "text", label: current });
              current = word;
            } else current = current ? `${current} ${word}` : word;
          }
          result.push({ kind: "text", label: current });
        }
      }
    }
    return result;
  };
  const start = () => Math.max(0, Math.min(offset(), rows().length - capacity()));
  const visibleRows = () => {
    const visible = rows().slice(start(), start() + capacity());
    while (visible.length && (visible.at(-1)?.kind === "gap" || visible.at(-1)?.kind === "heading"))
      visible.pop();
    return visible;
  };
  const move = (delta: number) =>
    setOffset(Math.max(0, Math.min(rows().length - capacity(), start() + delta)));
  const search = (value: string) => {
    setQuery(value);
    setOffset(0);
  };
  useKeyboardRoute((event) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.eventType === "release") return true;
    const key = event.name.toLowerCase();
    if (key === "escape") props.onClose();
    else if (key === "tab") {
      setPage(page() === "shortcuts" ? "changes" : "shortcuts");
      setOffset(0);
    } else if (key === "down") move(1);
    else if (key === "up") move(-1);
    else if (key === "pagedown") move(capacity());
    else if (key === "pageup") move(-capacity());
    else if (page() === "shortcuts") {
      const action = applicationPaneRenameKeyAction(event, query());
      if (action.kind === "update") search(action.value);
    } else if (key === "j") move(1);
    else if (key === "k") move(-1);
    return true;
  });
  usePasteRoute((bytes) => {
    if (page() === "shortcuts") search(applicationPaneRenamePaste(query(), bytes));
    return true;
  });
  return (
    <Dialog
      theme={props.theme}
      viewportWidth={props.width}
      viewportHeight={props.height}
      width={metrics().width}
      height={metrics().height}
      title={page() === "shortcuts" ? "Keyboard shortcuts" : "What's new"}
      footer="Tab switch sheet · ↑↓ scroll · Esc back"
      zIndex={100}
      onDismiss={props.onClose}
    >
      <box height={1} flexShrink={0} />
      <Show when={page() === "shortcuts"}>
        <OverlaySearchField
          theme={props.theme}
          width={metrics().contentWidth}
          query={query()}
          placeholder="Search actions or keys…"
        />
        <box height={1} flexShrink={0} />
      </Show>
      <box
        height={capacity()}
        flexShrink={0}
        flexDirection="column"
        overflow="hidden"
        onMouseScroll={(event) => {
          event.preventDefault();
          move(event.scroll.direction === "up" ? -3 : 3);
        }}
      >
        <For each={visibleRows()}>
          {(row) =>
            row.kind === "action" ? (
              <DetailRow
                theme={props.theme}
                width={metrics().contentWidth}
                label={row.label}
                detail={row.detail}
              />
            ) : (
              <text
                height={1}
                flexShrink={0}
                width={metrics().contentWidth}
                fg={
                  row.kind === "heading"
                    ? props.theme.roles.text.link
                    : props.theme.roles.text.secondary
                }
              >
                {row.kind === "heading" ? (
                  <strong>{clipTerminal(row.label, metrics().contentWidth)}</strong>
                ) : (
                  clipTerminal(row.label, metrics().contentWidth)
                )}
              </text>
            )
          }
        </For>
      </box>
    </Dialog>
  );
}
