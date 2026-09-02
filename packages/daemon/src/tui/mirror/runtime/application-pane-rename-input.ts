export const APPLICATION_PANE_NAME_MAX_LENGTH = 80;

export interface ApplicationPaneRenameDraft {
  readonly paneId: string;
  readonly value: string;
}

export type ApplicationPaneRenameKeyAction =
  | { readonly kind: "update"; readonly value: string }
  | { readonly kind: "submit" }
  | { readonly kind: "cancel" }
  | { readonly kind: "block" };

function appendBounded(current: string, input: string): string {
  const clean = [...input]
    .filter((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint > 0x1f && codePoint !== 0x7f;
    })
    .join("");
  return [...`${current}${clean}`].slice(0, APPLICATION_PANE_NAME_MAX_LENGTH).join("");
}

export function applicationPaneRenameKeyAction(
  event: Readonly<{ name: string; ctrl: boolean; meta: boolean; shift: boolean }>,
  value: string,
): ApplicationPaneRenameKeyAction {
  const name = event.name.toLowerCase();
  if (name === "escape") return { kind: "cancel" };
  if (name === "return" || name === "enter")
    return value.trim().length > 0 ? { kind: "submit" } : { kind: "block" };
  if (name === "backspace") return { kind: "update", value: [...value].slice(0, -1).join("") };
  if (event.ctrl && name === "u") return { kind: "update", value: "" };
  if (event.ctrl || event.meta || event.name.length !== 1) return { kind: "block" };
  return {
    kind: "update",
    value: appendBounded(value, event.shift ? event.name.toUpperCase() : event.name),
  };
}

export function applicationPaneRenamePaste(value: string, bytes: Uint8Array): string {
  return appendBounded(value, Buffer.from(bytes).toString("utf8"));
}
