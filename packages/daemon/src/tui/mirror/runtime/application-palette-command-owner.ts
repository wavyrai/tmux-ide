import type { CommandSource } from "@tmux-ide/contracts";
import { createSignal } from "solid-js";

import type { ApplicationPaletteCommand } from "./application-palette-input.ts";
import type { ApplicationShellBinding } from "./application-shell-binding.ts";
import { applicationPaletteCommands } from "./application-palette-input.ts";
import { createApplicationPaletteSearchOwner } from "./application-palette-search-owner.ts";
import type { ApplicationPluginForm } from "./application-plugin-form.ts";

type Source = "keyboard" | "mouse";

export function createApplicationPaletteCommandOwner(options: {
  readonly activeSurface: () => "home" | "terminals";
  readonly binding: Pick<
    ApplicationShellBinding,
    "openSurface" | "setPaletteOpen" | "activatePaletteSurface"
  >;
  readonly commandSource: (
    source: Source,
    surface: "application-bar" | "command-palette",
  ) => CommandSource;
  readonly setSurface: (surface: "home" | "terminals") => void;
  readonly setNote: (note: string | null) => void;
  readonly openNewAgent?: () => void;
  readonly openSessions?: () => void;
  readonly openAppearance?: () => void;
  readonly toggleSidebar?: () => void;
  readonly zoomPane?: () => Promise<string>;
  readonly newWindow: () => Promise<string>;
  readonly splitPane: (direction: "right" | "down") => Promise<string>;
  readonly closePane: () => Promise<string>;
  readonly openAgent: (sessionName: string, paneId: string, source: Source) => Promise<boolean>;
  readonly openFleet?: (
    command: Exclude<ApplicationPaletteCommand, string>,
    source: Source,
  ) => Promise<unknown> | void;
  readonly openSession?: (sessionName: string, source: Source) => Promise<unknown> | void;
  readonly onNavigationIntent?: () => void;
  readonly commands?: () => readonly ApplicationPaletteCommand[];
  readonly isOpen?: () => boolean;
  readonly disabledReason?: (command: ApplicationPaletteCommand) => string | null;
  readonly targetKey?: () => string;
  /** Plugin commands and their parameter form; absent when plugins are unavailable. */
  readonly plugins?: {
    readonly form: ApplicationPluginForm;
    /** Refresh the plugin command list; called whenever the palette opens. */
    readonly refresh: () => void;
    /** Follow catalog changes while the palette is open; returns a stop function. */
    readonly watch?: () => () => void;
  };
}) {
  const [referencePage, setReferencePage] = createSignal<"shortcuts" | "changes" | "help">();
  const [closeArmed, setCloseArmed] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  let armedTarget: string | undefined;
  let stopWatch: (() => void) | null = null;
  let openRevision = 0;
  const baseCommands = options.commands ?? (() => applicationPaletteCommands(null));
  const search = createApplicationPaletteSearchOwner({
    // While a plugin form is open the list is the current step's entries.
    commands: () =>
      options.plugins?.form.active() ? options.plugins.form.entries() : baseCommands(),
    open: options.isOpen ?? (() => false),
    activate: (command, source) => activate(command, source),
    close: () => setOpen(false, "keyboard"),
    onChange: () => setCloseArmed(false),
  });
  const setOpen = (open: boolean, source: Source): void => {
    setReferencePage(undefined);
    openRevision += 1;
    setCloseArmed(false);
    options.plugins?.form.cancel();
    stopWatch?.();
    stopWatch = null;
    if (open) {
      options.plugins?.refresh();
      stopWatch = options.plugins?.watch?.() ?? null;
      search.reset(options.activeSurface() === "home" ? 0 : 1);
    }
    void options.binding
      .setPaletteOpen(open, options.commandSource(source, "command-palette"))
      .catch(() => options.setNote("Commands could not be updated. Try again."));
  };
  const activate = (
    command: ApplicationPaletteCommand,
    source: Source,
    confirmed = false,
  ): void => {
    if (busy()) return;
    if (command === "help" || command === "shortcuts" || command === "whats-new") {
      setCloseArmed(false);
      setReferencePage(
        command === "help" ? "help" : command === "shortcuts" ? "shortcuts" : "changes",
      );
      return;
    }
    if (typeof command === "object" && command.kind === "plugin-form") {
      if (command.disabledReason) {
        options.setNote(command.disabledReason);
        return;
      }
      options.plugins?.form.choose(command);
      return;
    }
    if (typeof command === "object" && command.kind === "plugin-command") {
      if (!options.plugins) {
        options.setNote("Plugin commands are unavailable.");
        return;
      }
      options.plugins.form.start(command);
      return;
    }
    if (command === "switch-session") {
      if (!options.openSessions) {
        options.setNote("Session switching is unavailable.");
        return;
      }
      setOpen(false, source);
      options.openSessions();
      return;
    }
    if (command === "hide-sidebar" || command === "show-sidebar") {
      setOpen(false, source);
      options.toggleSidebar?.();
      return;
    }
    if (command === "appearance") {
      setOpen(false, source);
      options.openAppearance?.();
      return;
    }
    const unavailable = options.disabledReason?.(command);
    if (unavailable) {
      setCloseArmed(false);
      options.setNote(unavailable);
      return;
    }
    if (command === "new-agent") {
      setOpen(false, source);
      options.openNewAgent?.();
      return;
    }
    if (typeof command === "object" && command.fleet) {
      if (command.fleet.disabled || !options.openFleet) {
        options.setNote("That machine or session is unavailable.");
        return;
      }
      options.onNavigationIntent?.();
      setOpen(false, source);
      void Promise.resolve(options.openFleet(command, source)).catch(() =>
        options.setNote("That fleet target could not be opened."),
      );
      return;
    }
    if (typeof command === "object" && command.kind === "open-session") {
      options.onNavigationIntent?.();
      setCloseArmed(false);
      setOpen(false, source);
      if (!options.openSession) {
        options.setNote("Session switching is unavailable.");
        return;
      }
      try {
        // Begin ingress ownership synchronously, before the next terminal key.
        void Promise.resolve(options.openSession(command.sessionName, source)).catch(() => {
          options.setNote("The selected session could not be opened.");
        });
      } catch {
        options.setNote("The selected session could not be opened.");
      }
      return;
    }
    if (typeof command === "object" && command.kind === "jump-agent") {
      options.onNavigationIntent?.();
      setCloseArmed(false);
      setOpen(false, source);
      void options
        .openAgent(command.sessionName, command.paneId, source)
        .catch(() => options.setNote("The selected agent could not be opened."));
      return;
    }
    if (command === "home" || command === "terminals") {
      options.onNavigationIntent?.();
      setCloseArmed(false);
      void options.binding
        .activatePaletteSurface(command, options.commandSource(source, "command-palette"))
        .then((dispatched) => {
          if (!dispatched) options.setSurface(command);
        })
        .catch(() => options.setNote("The selected surface could not be opened."));
      return;
    }
    if (
      command === "close-pane" &&
      !confirmed &&
      (!closeArmed() || armedTarget !== options.targetKey?.())
    ) {
      armedTarget = options.targetKey?.();
      setCloseArmed(true);
      options.setNote("Close pane is destructive · activate again to confirm");
      return;
    }
    setCloseArmed(false);
    setBusy(true);
    const revision = openRevision;
    let operation: Promise<string>;
    try {
      operation =
        command === "zoom-pane"
          ? (options.zoomPane?.() ?? Promise.resolve("Zoom unavailable"))
          : command === "close-pane"
            ? options.closePane()
            : command === "new-window"
              ? options.newWindow()
              : options.splitPane(command === "split-right" ? "right" : "down");
    } catch {
      setBusy(false);
      options.setNote("Command failed. Check the live session and try again.");
      return;
    }
    void operation
      .then((message) => {
        options.setNote(message);
        if (revision === openRevision) setOpen(false, source);
      })
      .catch(() => options.setNote("Command failed. Check the live session and try again."))
      .finally(() => setBusy(false));
  };
  return {
    ...search,
    keyboardHint: () =>
      options.plugins?.form.active() ? options.plugins.form.hint() : search.keyboardHint(),
    /** Clear the search line and selection for a new form step. */
    resetForStep: () => search.reset(0),
    referencePage,
    setReferencePage,
    busy,
    disabledReason: options.disabledReason ?? (() => null),
    closeArmed: () => closeArmed() && armedTarget === options.targetKey?.(),
    setOpen,
    activate,
    openSurface(surface: "home" | "terminals", source: Source) {
      options.onNavigationIntent?.();
      void options.binding
        .openSurface(surface, options.commandSource(source, "application-bar"))
        .then((dispatched) => {
          if (!dispatched) options.setSurface(surface);
        });
    },
  };
}
