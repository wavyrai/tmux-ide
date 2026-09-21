/* @jsxImportSource @opentui/solid */
import { createSignal, For } from "solid-js";
import type { SemanticThemeSnapshot } from "../theme.ts";
import { Dialog } from "../ui/dialog.tsx";
import { TuiButton } from "../ui/button.tsx";
import { useKeyboardRoute } from "../ui/keyboard-router.tsx";
import { clipTerminal } from "../terminal-text.ts";

const shortcuts = [
  "APPLICATION",
  "F1  Home  ·  F2  Terminals",
  "F5  Commands  ·  F6  Sessions across machines",
  "F7  Agent attention  ·  Ctrl+G  Machine sidebar",
  "IN THE COMMAND / SESSION MENU",
  "Type to search  ·  ↑/↓ choose  ·  Enter activate",
  "Ctrl+Space  Toggle search / navigation mode",
  "Navigation mode: j/k move · g/G first/last · i search",
  "PageUp/PageDown page  ·  Ctrl+U/D half page",
  "Ctrl+H  Local / all hosts  ·  Ctrl+F  Favorite session",
  "Ctrl+←/→  Browse windows without activating them",
  "Ctrl+P  Show / hide preview  ·  Ctrl+E  Expand / restore",
  "Ctrl+N  New session  ·  Ctrl+X  Confirm close session",
  "Ctrl+R  Retry selected host",
  "Ctrl+K  Shortcuts  ·  Ctrl+B  What's new",
  "Esc  Close sheet / menu and return to your terminal",
];
const changes = [
  "LATEST CHANGES",
  "Agent previews follow the highlighted pane in the session.",
  "Pane identity isolates cached previews and late responses.",
  "Shortcuts and release history are available offline here.",
  "",
  "2.9.0-beta.18",
  "Shared F5/F6 switcher with side-by-side previews in wide terminals.",
  "Cached previews appear immediately while a fresh snapshot loads.",
  "Fuzzy search, match highlighting, favorites and recent sessions.",
  "Window browsing, expanded previews and bounded background work.",
  "Create / confirm close on the selected host without leaving the menu.",
  "",
  "2.9.0-beta.17",
  "Fleet navigation, passive window previews and activity summaries.",
  "Adaptive refresh and exact-host actions across machines.",
  "",
  "Full release history: github.com/wavyrai/tmux-ide/releases",
];

export function ApplicationReferenceSheet(props: {
  page: "shortcuts" | "changes";
  width: number;
  height: number;
  theme: SemanticThemeSnapshot;
  onClose: () => void;
}) {
  const [page, setPage] = createSignal(props.page);
  const [offset, setOffset] = createSignal(0);
  const rows = () => (page() === "shortcuts" ? shortcuts : changes);
  const capacity = () => Math.max(1, Math.min(24, props.height - 8));
  const move = (delta: number) =>
    setOffset((v) => Math.max(0, Math.min(rows().length - capacity(), v + delta)));
  const change = (next: "shortcuts" | "changes") => {
    setPage(next);
    setOffset(0);
  };
  useKeyboardRoute((event) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.eventType !== "press") return true;
    const key = event.name.toLowerCase();
    if (key === "escape") props.onClose();
    else if (key === "tab") change(page() === "shortcuts" ? "changes" : "shortcuts");
    else if (key === "down" || key === "j") move(1);
    else if (key === "up" || key === "k") move(-1);
    else if (key === "pagedown") move(capacity());
    else if (key === "pageup") move(-capacity());
    return true;
  });
  return (
    <Dialog
      theme={props.theme}
      viewportWidth={props.width}
      viewportHeight={props.height}
      width={Math.min(88, Math.max(1, props.width - 4))}
      height={Math.min(props.height, capacity() + 6)}
      title={page() === "shortcuts" ? "Keyboard shortcuts" : "What's new"}
      footer="Tab switch sheet · ↑↓ scroll · Esc back"
      zIndex={100}
      onDismiss={props.onClose}
    >
      <box height={1} flexDirection="row" gap={1}>
        <TuiButton
          theme={props.theme}
          label="Shortcuts"
          size="compact"
          onPress={() => change("shortcuts")}
        />
        <TuiButton
          theme={props.theme}
          label="What's new"
          size="compact"
          onPress={() => change("changes")}
        />
        <TuiButton theme={props.theme} label="Back" size="compact" onPress={props.onClose} />
      </box>
      <box
        flexDirection="column"
        height={capacity()}
        overflow="hidden"
        onMouseScroll={(event) => {
          event.preventDefault();
          move(event.scroll.direction === "up" ? -3 : 3);
        }}
      >
        <For each={rows().slice(offset(), offset() + capacity())}>
          {(line) => (
            <text
              height={1}
              fg={props.theme.roles.text.primary}
              content={clipTerminal(line, Math.max(1, Math.min(88, props.width - 4) - 4))}
            />
          )}
        </For>
      </box>
    </Dialog>
  );
}
