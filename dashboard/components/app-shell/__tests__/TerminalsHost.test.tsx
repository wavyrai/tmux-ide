import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalsHost } from "../TerminalsHost";
import {
  __resetNavigationForTests,
  activateTab,
  closeTab,
  defaultTerminalTabId,
  ensureDefaultTerminal,
  openTerminalTab,
  setActiveSession,
  viewTab,
  openTab,
} from "@/lib/navigation";

// Mock heavy xterm boot — we only care about lifecycle (mount/unmount)
// in this test, not WebSocket / WebGL plumbing.
vi.mock("@/components/Terminal", () => ({
  Terminal: ({ id }: { id: string }) => <div data-testid={`mock-terminal-${id}`}>{id}</div>,
}));

vi.mock("@/lib/api", () => ({
  fetchMission: vi.fn(async () => null),
  injectIntoProject: vi.fn(async () => true),
}));

beforeEach(() => {
  window.localStorage.clear();
  __resetNavigationForTests({ type: "overview" });
});

afterEach(() => {
  __resetNavigationForTests({ type: "overview" });
});

describe("TerminalsHost", () => {
  it("renders nothing when no terminal tabs are open", () => {
    setActiveSession("alpha");
    const { container } = render(<TerminalsHost />);
    expect(container.firstChild).toBeNull();
  });

  it("mounts a Terminal for each terminal tab and only displays the active one", () => {
    setActiveSession("alpha");
    ensureDefaultTerminal("alpha");
    const adhoc = openTerminalTab("alpha", { title: "shell" });

    render(<TerminalsHost />);

    const defaultId = defaultTerminalTabId("alpha");
    expect(screen.getByTestId(`mock-terminal-${defaultId}`)).toBeTruthy();
    expect(screen.getByTestId(`mock-terminal-${adhoc.id}`)).toBeTruthy();

    // The active tab is the most recently opened (`adhoc`). Its slot
    // should be visible; the older default's slot should be hidden.
    const slots = document.querySelectorAll<HTMLElement>("[data-terminal-slot]");
    const adhocSlot = Array.from(slots).find(
      (el) => el.dataset.terminalSlot === adhoc.id,
    );
    const defaultSlot = Array.from(slots).find(
      (el) => el.dataset.terminalSlot === defaultId,
    );
    expect(adhocSlot?.style.display).toBe("flex");
    expect(defaultSlot?.style.display).toBe("none");
  });

  it("hides the host when the active tab is not a terminal", () => {
    setActiveSession("alpha");
    ensureDefaultTerminal("alpha");
    // Open a non-terminal view and activate it.
    const view = viewTab("alpha", "plans");
    openTab(view);
    activateTab(view.id);

    render(<TerminalsHost />);

    const host = screen.getByTestId("terminals-host");
    expect(host.getAttribute("data-active")).toBe("false");
    expect(host.style.display).toBe("none");
  });

  it("keeps inactive Terminal instances mounted across tab switches (state survives)", () => {
    setActiveSession("alpha");
    ensureDefaultTerminal("alpha");
    const view = viewTab("alpha", "plans");
    openTab(view);

    const { rerender } = render(<TerminalsHost />);
    const defaultId = defaultTerminalTabId("alpha");
    const initialNode = screen.getByTestId(`mock-terminal-${defaultId}`);

    activateTab(view.id);
    rerender(<TerminalsHost />);

    // Same DOM node — never unmounted.
    const sameNode = screen.getByTestId(`mock-terminal-${defaultId}`);
    expect(sameNode).toBe(initialNode);

    // Switch back; still the same node.
    activateTab(defaultId);
    rerender(<TerminalsHost />);
    expect(screen.getByTestId(`mock-terminal-${defaultId}`)).toBe(initialNode);
  });

  it("unmounts a Terminal when its tab is closed", () => {
    setActiveSession("alpha");
    const tab = ensureDefaultTerminal("alpha");

    const { rerender } = render(<TerminalsHost />);
    expect(screen.getByTestId(`mock-terminal-${tab.id}`)).toBeTruthy();

    closeTab(tab.id);
    rerender(<TerminalsHost />);

    expect(screen.queryByTestId(`mock-terminal-${tab.id}`)).toBeNull();
  });

  it("renders the terminal header with the active tab's identity", () => {
    setActiveSession("alpha");
    ensureDefaultTerminal("alpha");

    render(<TerminalsHost />);

    const header = screen.getByTestId("terminal-header");
    expect(header.textContent).toContain("alpha");
    expect(header.textContent).toContain("tmux-ide");
  });
});
