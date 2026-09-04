import type { CommandSource } from "@tmux-ide/contracts";
import { createSignal } from "solid-js";

import type { ApplicationPaletteCommand } from "./application-palette-input.ts";
import type { ApplicationShellBinding } from "./application-shell-binding.ts";
import { applicationPaletteCommands } from "./application-palette-input.ts";
import { createApplicationPaletteSearchOwner } from "./application-palette-search-owner.ts";

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
  readonly newWindow: () => Promise<string>;
  readonly splitPane: (direction: "right" | "down") => Promise<string>;
  readonly closePane: () => Promise<string>;
  readonly openAgent: (sessionName: string, paneId: string, source: Source) => Promise<boolean>;
  readonly openSession?: (sessionName: string, source: Source) => Promise<unknown> | void;
  readonly onNavigationIntent?: () => void;
  readonly commands?: () => readonly ApplicationPaletteCommand[];
  readonly isOpen?: () => boolean;
  readonly disabledReason?: (command: ApplicationPaletteCommand) => string | null;
  readonly targetKey?: () => string;
}) {
  const [closeArmed, setCloseArmed] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  let armedTarget: string | undefined;
  let openRevision = 0;
  const search = createApplicationPaletteSearchOwner({
    commands: options.commands ?? (() => applicationPaletteCommands(null)),
    open: options.isOpen ?? (() => false),
    activate: (command, source) => activate(command, source),
    close: () => setOpen(false, "keyboard"),
    onChange: () => setCloseArmed(false),
  });
  const setOpen = (open: boolean, source: Source): void => {
    openRevision += 1;
    setCloseArmed(false);
    if (open) search.reset(options.activeSurface() === "home" ? 0 : 1);
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
    const unavailable = options.disabledReason?.(command);
    if (unavailable) {
      setCloseArmed(false);
      options.setNote(unavailable);
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
        command === "close-pane"
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
