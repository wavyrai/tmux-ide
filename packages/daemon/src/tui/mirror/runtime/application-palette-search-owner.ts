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
  pageSize?: () => number;
  onChange: () => void;
}) {
  const [localOnly, setLocalOnly] = createSignal(false);
  const [viewport, setViewport] = createSignal(10);
  const pageSize = () => options.pageSize?.() ?? viewport();
  const [normal, setNormal] = createSignal(false);
  const [help, setHelp] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const commands = createMemo(() =>
    filterApplicationCommands(
      options
        .commands()
        .filter(
          (c) => !localOnly() || typeof c === "string" || !c.fleet || c.fleet.machineId === "local",
        ),
      query(),
    ),
  );
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
    setViewport,
    setQuery: updateQuery,
    keyboardHint: () =>
      (localOnly() ? "LOCAL ONLY · ^H all hosts · " : "") +
      (help()
        ? "j/k g/G ^U/D · i search · ^N new · ^X close · ^F favorite · ^←/→ windows · ^P hide · ^E expand"
        : normal()
          ? "NORMAL · i search · ? help · Ctrl-Space mode"
          : "SEARCH · ^Space navigation · ^H local/all hosts"),
    commands,
    selection,
    select,
    reset(index: number) {
      setNormal(false);
      setHelp(false);
      setQuery("");
      setSelectedId(null);
      select(index);
    },
    handleKey(event: Parameters<typeof applicationPaneRenameKeyAction>[0]) {
      if (!options.open()) return false;
      if (event.eventType === "release") return true;
      const name = event.name.toLowerCase();
      if (event.ctrl && name === "h") {
        setLocalOnly(!localOnly());
        return true;
      }
      if (event.ctrl && name === "space") {
        setNormal(!normal());
        return true;
      }
      if (normal()) {
        if (name === "i" || (name === "/" && !event.shift)) {
          setNormal(false);
          return true;
        }
        if (name === "?" || (name === "/" && event.shift)) {
          setHelp(!help());
          return true;
        }
        if (name === "escape") {
          options.close();
          return true;
        }
        const last = Math.max(0, commands().length - 1);
        const halfPage = Math.max(1, Math.floor(pageSize() / 2));
        const delta =
          name === "j"
            ? 1
            : name === "k"
              ? -1
              : event.ctrl && name === "d"
                ? halfPage
                : event.ctrl && name === "u"
                  ? -halfPage
                  : 0;
        if (name === "g") {
          select(event.shift ? last : 0);
          return true;
        }
        if (delta) {
          select(Math.max(0, Math.min(last, selection() + delta)));
          return true;
        }
        if (!["up", "down", "enter", "return", "home", "end", "pageup", "pagedown"].includes(name))
          return true;
      }
      if (["home", "end", "pageup", "pagedown"].includes(name)) {
        const last = Math.max(0, commands().length - 1);
        select(
          name === "home"
            ? 0
            : name === "end"
              ? last
              : Math.max(
                  0,
                  Math.min(
                    last,
                    selection() + (name === "pageup" ? -1 : 1) * Math.max(1, pageSize()),
                  ),
                ),
        );
        return true;
      }
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
