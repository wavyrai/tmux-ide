interface Key {
  readonly name: string;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly meta?: boolean;
  readonly eventType?: string;
  preventDefault(): void;
  stopPropagation(): void;
}

export function isSidebarToggleKey(key: Omit<Key, "preventDefault" | "stopPropagation">): boolean {
  return (
    key.name.toLowerCase() === "f10" &&
    !key.shift &&
    !key.ctrl &&
    !key.meta &&
    key.eventType !== "release"
  );
}

export function createApplicationSidebarShortcuts(
  surface: () => string,
  visible: () => boolean,
  setVisible: (update: (value: boolean) => boolean) => unknown,
  machines: {
    showSwitcher(attention: boolean): void;
    focus(): void;
    sidebar: { onBlur?: () => void };
  },
  palette: { setOpen(open: boolean, source: "keyboard"): void },
): (event: Key) => boolean {
  return (event) => {
    if (event.name.toLowerCase() === "f5") {
      machines.sidebar.onBlur?.();
      palette.setOpen(true, "keyboard");
      return true;
    }
    if (isSidebarToggleKey(event)) {
      event.preventDefault();
      event.stopPropagation();
      if (event.eventType === "press") setVisible((value) => !value);
      return true;
    }
    if (event.ctrl && event.name.toLowerCase() === "g") {
      if (surface() === "home" || !visible()) machines.showSwitcher(false);
      else machines.focus();
      return true;
    }
    return false;
  };
}
