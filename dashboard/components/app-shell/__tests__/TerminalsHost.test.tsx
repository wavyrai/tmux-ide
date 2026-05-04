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
  Terminal: ({
    id,
    cwd,
    cmd,
  }: {
    id: string;
    cwd?: string;
    cmd?: string[];
    showHeader?: boolean;
    onSessionExit?: (id: string) => void;
  }) => (
    <div
      data-testid={`mock-terminal-${id}`}
      data-cwd={cwd ?? ""}
      data-cmd={cmd ? cmd.join("|") : ""}
    >
      {id}
    </div>
  ),
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

  it("forwards cwd / cmd from the terminal tab into the Terminal component", () => {
    setActiveSession("alpha");
    const cwd = "/tmp/projects/alpha";
    const cmd = ["__login_shell__", "tmux-ide"];
    const tab = openTerminalTab("alpha", { cwd, cmd, title: "tmux-ide" });

    render(<TerminalsHost />);

    const mock = screen.getByTestId(`mock-terminal-${tab.id}`);
    expect(mock.dataset.cwd).toBe(cwd);
    expect(mock.dataset.cmd).toBe(cmd.join("|"));
  });

  it("renders the host as an absolute overlay so it covers the panel without competing for flex space", () => {
    setActiveSession("alpha");
    ensureDefaultTerminal("alpha");

    render(<TerminalsHost />);
    const host = screen.getByTestId("terminals-host");

    // Hard requirement: absolute-positioned overlay sitting on top of
    // MainTabContent. Without `absolute inset-0` the host would steal
    // flex space and shrink sibling panels.
    expect(host.className).toContain("absolute");
    expect(host.className).toContain("inset-0");
    // z-index has to be > 0 so it paints above MainTabContent.
    expect(host.className).toMatch(/z-\d+/);
  });

  it("keeps the Terminal mounted even when a non-terminal tab is active", () => {
    setActiveSession("alpha");
    const term = ensureDefaultTerminal("alpha");
    const view = viewTab("alpha", "kanban");
    openTab(view);
    activateTab(view.id);

    render(<TerminalsHost />);

    // Host hides via display:none but the terminal stays mounted so
    // its xterm + WebSocket survive the tab switch.
    const host = screen.getByTestId("terminals-host");
    expect(host.style.display).toBe("none");
    expect(screen.getByTestId(`mock-terminal-${term.id}`)).toBeTruthy();
  });

  it("flips slot display from none -> flex when activating a hidden terminal tab", () => {
    setActiveSession("alpha");
    const t1 = ensureDefaultTerminal("alpha");
    const t2 = openTerminalTab("alpha", { title: "shell" });

    const { rerender } = render(<TerminalsHost />);

    // t2 is the most recently opened and is the active terminal.
    let slots = document.querySelectorAll<HTMLElement>("[data-terminal-slot]");
    let slotMap = new Map(
      Array.from(slots).map((s) => [s.dataset.terminalSlot, s.style.display]),
    );
    expect(slotMap.get(t2.id)).toBe("flex");
    expect(slotMap.get(t1.id)).toBe("none");

    // Switch to the older terminal — slot displays flip.
    activateTab(t1.id);
    rerender(<TerminalsHost />);
    slots = document.querySelectorAll<HTMLElement>("[data-terminal-slot]");
    slotMap = new Map(
      Array.from(slots).map((s) => [s.dataset.terminalSlot, s.style.display]),
    );
    expect(slotMap.get(t1.id)).toBe("flex");
    expect(slotMap.get(t2.id)).toBe("none");
  });

  it("updates the terminal header when the active terminal changes", () => {
    setActiveSession("alpha");
    ensureDefaultTerminal("alpha");
    const adhoc = openTerminalTab("alpha", { title: "shell-2" });

    const { rerender } = render(<TerminalsHost />);

    // Most recently opened (adhoc) is active by default.
    expect(screen.getByTestId("terminal-header").textContent).toContain("shell-2");

    // Switch to default — header swaps title.
    activateTab(defaultTerminalTabId("alpha"));
    rerender(<TerminalsHost />);
    expect(screen.getByTestId("terminal-header").textContent).toContain("tmux-ide");

    // And back.
    activateTab(adhoc.id);
    rerender(<TerminalsHost />);
    expect(screen.getByTestId("terminal-header").textContent).toContain("shell-2");
  });

  it("exposes data-active-terminal pointing at the active terminal id", () => {
    setActiveSession("alpha");
    const tab = ensureDefaultTerminal("alpha");

    render(<TerminalsHost />);

    const host = screen.getByTestId("terminals-host");
    expect(host.dataset.activeTerminal).toBe(tab.id);
  });
});
