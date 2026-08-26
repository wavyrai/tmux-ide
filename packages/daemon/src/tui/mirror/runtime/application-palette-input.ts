export type ApplicationPaletteCommand =
  | "home"
  | "terminals"
  | "split-right"
  | "split-down"
  | "close-pane";

const COMMANDS: readonly ApplicationPaletteCommand[] = [
  "home",
  "terminals",
  "split-right",
  "split-down",
  "close-pane",
];

export type ApplicationPaletteKeyAction =
  | { readonly kind: "select"; readonly index: number }
  | { readonly kind: "activate"; readonly command: ApplicationPaletteCommand }
  | { readonly kind: "close" };

export function applicationPaletteKeyAction(
  key: { readonly name: string },
  paletteOpen: boolean,
  selected: number,
): ApplicationPaletteKeyAction | null {
  if (!paletteOpen) return null;
  const name = key.name.toLowerCase();
  if (name === "up")
    return { kind: "select", index: (selected - 1 + COMMANDS.length) % COMMANDS.length };
  if (name === "down") return { kind: "select", index: (selected + 1) % COMMANDS.length };
  if (name === "return" || name === "enter") {
    const command = COMMANDS[selected];
    return command ? { kind: "activate", command } : null;
  }
  if (name === "f1") return { kind: "activate", command: "home" };
  if (name === "f2") return { kind: "activate", command: "terminals" };
  if (name === "escape") return { kind: "close" };
  return null;
}

/** Palette modality is shared by keyboard, paste, and pointer routing. */
export function applicationPaletteOwnsInput(open: boolean): boolean {
  return open;
}

export type ApplicationPaletteKeyboardDisposition =
  | ApplicationPaletteKeyAction
  | { readonly kind: "block" };

export function applicationPaletteKeyboardDisposition(
  key: { readonly name: string },
  open: boolean,
  selected: number,
): ApplicationPaletteKeyboardDisposition | null {
  return applicationPaletteKeyAction(key, open, selected) ?? (open ? { kind: "block" } : null);
}
