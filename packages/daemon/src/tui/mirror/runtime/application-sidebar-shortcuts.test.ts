import { expect, it, vi } from "vitest";
import { createApplicationSidebarShortcuts } from "./application-sidebar-shortcuts.ts";

it("toggles the sidebar and routes focus to Sessions when it is hidden", () => {
  let visible = true;
  const machines = { showSwitcher: vi.fn(), focus: vi.fn(), sidebar: { onBlur: vi.fn() } };
  const palette = { setOpen: vi.fn() };
  const handle = createApplicationSidebarShortcuts(
    () => "terminals",
    () => visible,
    (update) => {
      visible = update(visible);
    },
    machines,
    palette,
  );
  const key = (name: string, extra = {}) => ({
    name,
    eventType: "press",
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...extra,
  });
  expect(handle(key("f10", { shift: true }))).toBe(false);
  expect(handle(key("f10"))).toBe(true);
  expect(visible).toBe(false);
  expect(handle(key("f10", { eventType: "release" }))).toBe(false);
  expect(visible).toBe(false);
  handle(key("g", { ctrl: true }));
  expect(machines.showSwitcher).toHaveBeenCalledWith(false);
  handle(key("f10"));
  handle(key("g", { ctrl: true }));
  expect(machines.focus).toHaveBeenCalledOnce();
  handle(key("f5"));
  expect(machines.sidebar.onBlur).toHaveBeenCalledOnce();
  expect(palette.setOpen).toHaveBeenCalledWith(true, "keyboard");
});
