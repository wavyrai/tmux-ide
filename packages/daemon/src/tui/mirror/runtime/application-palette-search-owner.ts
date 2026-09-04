import { createMemo, createSignal } from "solid-js";
import {
  applicationCommandDescription,
  filterApplicationCommands,
} from "../workspace/application-command-description.ts";
import {
  applicationPaletteKeyboardDisposition,
  type ApplicationPaletteCommand,
} from "./application-palette-input.ts";
import {
  applicationPaneRenameKeyAction,
  applicationPaneRenamePaste,
} from "./application-pane-rename-input.ts";

/** Query/selection/input only. No physical listeners or terminal subscriptions. */
export function createApplicationPaletteSearchOwner(options: {
  commands: () => readonly ApplicationPaletteCommand[];
  open: () => boolean;
  activate: (command: ApplicationPaletteCommand, source: "keyboard" | "mouse") => void;
  close: () => void;
  onChange: () => void;
}) {
  const [query, setQuery] = createSignal("");
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const commands = createMemo(() => filterApplicationCommands(options.commands(), query()));
  const selection = () =>
    Math.max(
      0,
      commands().findIndex((command) => applicationCommandDescription(command).id === selectedId()),
    );
  const select = (index: number) => {
    const command = commands()[index];
    if (!command) return;
    const id = applicationCommandDescription(command).id;
    if (id !== selectedId()) options.onChange();
    setSelectedId(id);
  };
  const updateQuery = (value: string) => {
    if (value === query()) return;
    options.onChange();
    setQuery(value);
    select(0);
  };
  return {
    query,
    commands,
    selection,
    select,
    reset(index: number) {
      setQuery("");
      setSelectedId(null);
      select(index);
    },
    handleKey(event: Parameters<typeof applicationPaneRenameKeyAction>[0]) {
      if (!options.open()) return false;
      if (event.eventType === "release") return true;
      const action =
        !event.ctrl && !event.meta
          ? applicationPaletteKeyboardDisposition(event, true, selection(), commands())
          : null;
      if (action?.kind === "close") options.close();
      else if (action?.kind === "select") select(action.index);
      else if (action?.kind === "activate") {
        if (!event.repeated && event.eventType !== "repeat")
          options.activate(action.command, "keyboard");
      } else {
        const edit = applicationPaneRenameKeyAction(event, query());
        if (edit.kind === "update") updateQuery(edit.value);
      }
      return true;
    },
    handlePaste(bytes: Uint8Array) {
      if (!options.open()) return false;
      updateQuery(applicationPaneRenamePaste(query(), bytes));
      return true;
    },
  };
}
