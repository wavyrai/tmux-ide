import type { CommandSource } from "@tmux-ide/contracts";
import { createSignal } from "solid-js";

import type { ApplicationPaletteCommand } from "./application-palette-input.ts";
import type { ApplicationShellBinding } from "./application-shell-binding.ts";

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
  readonly splitPane: (direction: "right" | "down") => Promise<string>;
  readonly closePane: () => Promise<string>;
}) {
  const [selection, setSelection] = createSignal(options.activeSurface() === "home" ? 0 : 1);
  const [closeArmed, setCloseArmed] = createSignal(false);
  const setOpen = (open: boolean, source: Source): void => {
    setCloseArmed(false);
    if (open) setSelection(options.activeSurface() === "home" ? 0 : 1);
    void options.binding.setPaletteOpen(open, options.commandSource(source, "command-palette"));
  };
  const activate = (command: ApplicationPaletteCommand, source: Source): void => {
    if (command === "home" || command === "terminals") {
      setCloseArmed(false);
      void options.binding
        .activatePaletteSurface(command, options.commandSource(source, "command-palette"))
        .then((dispatched) => {
          if (!dispatched) options.setSurface(command);
        });
      return;
    }
    if (command === "close-pane" && !closeArmed()) {
      setCloseArmed(true);
      options.setNote("Close pane is destructive · activate again to confirm");
      return;
    }
    setCloseArmed(false);
    void (
      command === "close-pane"
        ? options.closePane()
        : options.splitPane(command === "split-right" ? "right" : "down")
    ).then((message) => {
      options.setNote(message);
      setOpen(false, source);
    });
  };
  return {
    selection,
    closeArmed,
    setOpen,
    activate,
    openSurface(surface: "home" | "terminals", source: Source) {
      void options.binding
        .openSurface(surface, options.commandSource(source, "application-bar"))
        .then((dispatched) => {
          if (!dispatched) options.setSurface(surface);
        });
    },
    select(index: number) {
      setCloseArmed(false);
      setSelection(index);
    },
  };
}
