/* @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import type { DaemonInstanceIdentity } from "@tmux-ide/contracts";

import {
  FleetSidebarSection,
  promoteFailureSentence,
  type FleetPromoteOutcome,
} from "./fleet-sidebar.tsx";
import { SURFACE_MENU_IDS } from "./multiplexer-verb-menu.ts";
import type { DesktopFleetCatalogState } from "../runtime/fleet-catalog-store.ts";
import { FLEET_FIXTURE_DAEMON, mixedFleetCatalog } from "../runtime/fleet-catalog-fixture.ts";

const DAEMON: DaemonInstanceIdentity = FLEET_FIXTURE_DAEMON;

let dispose: (() => void) | null = null;

afterEach(() => {
  dispose?.();
  dispose = null;
  document.body.innerHTML = "";
});

function mount(node: () => unknown): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  dispose = render(node as never, host);
  return host;
}

function liveState(): DesktopFleetCatalogState {
  return {
    status: "live",
    generation: 1,
    daemon: DAEMON,
    snapshot: { daemon: DAEMON, catalog: mixedFleetCatalog(), updatedAt: 0 },
  };
}

function text(host: HTMLElement): string {
  return host.textContent ?? "";
}

describe("FleetSidebarSection", () => {
  it("renders every adopted session and its agents", () => {
    const host = mount(() => (
      <FleetSidebarSection state={liveState()} onPromote={async () => ({ ok: true })} />
    ));
    const body = text(host);
    for (const label of ["web", "api", "scratch", "Claude", "Reviewer"]) {
      expect(body).toContain(label);
    }
    expect(host.querySelector(".fleet-sidebar__badge--adopted")).toBeTruthy();
  });

  it("marks the open session and hides its Open action", () => {
    const host = mount(() => (
      <FleetSidebarSection
        state={liveState()}
        openSessionId="session.aaaaaaaaaaaaaaaa"
        onPromote={async () => ({ ok: true })}
      />
    ));
    expect(host.querySelector(".fleet-sidebar__badge--open")).toBeTruthy();
    expect(host.querySelector('[aria-label="Open web as workspace"]')).toBeNull();
    // The adopted "api" session still offers promotion.
    expect(host.querySelector('[aria-label="Open api as workspace"]')).toBeTruthy();
  });

  it("confirms a promotion through the dialog and calls onPromote once", async () => {
    const onPromote = vi.fn<(id: string) => Promise<FleetPromoteOutcome>>(async () => ({
      ok: true,
    }));
    const host = mount(() => <FleetSidebarSection state={liveState()} onPromote={onPromote} />);
    (host.querySelector('[aria-label="Open web as workspace"]') as HTMLButtonElement).click();
    const dialog = host.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("writes tmux-ide identity options");
    (host.querySelector(".fleet-sidebar__dialog-confirm") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(onPromote).toHaveBeenCalledWith("session.aaaaaaaaaaaaaaaa"));
    await vi.waitFor(() => expect(host.querySelector('[role="dialog"]')).toBeNull());
    expect(onPromote).toHaveBeenCalledOnce();
  });

  it("cancels without promoting", async () => {
    const onPromote = vi.fn<(id: string) => Promise<FleetPromoteOutcome>>(async () => ({
      ok: true,
    }));
    const host = mount(() => <FleetSidebarSection state={liveState()} onPromote={onPromote} />);
    (host.querySelector('[aria-label="Open web as workspace"]') as HTMLButtonElement).click();
    expect(host.querySelector('[role="dialog"]')).toBeTruthy();
    (host.querySelector(".fleet-sidebar__dialog-cancel") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(host.querySelector('[role="dialog"]')).toBeNull());
    expect(onPromote).not.toHaveBeenCalled();
  });

  it("keeps the dialog open and shows the capability reason on a transport failure", async () => {
    const onPromote = vi.fn<(id: string) => Promise<FleetPromoteOutcome>>(async () => ({
      ok: false,
      error: { code: "daemon-unavailable", reason: "The canonical daemon is unavailable." },
    }));
    const host = mount(() => <FleetSidebarSection state={liveState()} onPromote={onPromote} />);
    (host.querySelector('[aria-label="Open web as workspace"]') as HTMLButtonElement).click();
    (host.querySelector(".fleet-sidebar__dialog-confirm") as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(host.querySelector('[role="alert"]')?.textContent).toContain("daemon is unavailable"),
    );
    expect(host.querySelector('[role="dialog"]')).toBeTruthy();
  });

  it("shows the specific typed reason when the daemon returns a promotion verdict", async () => {
    const onPromote = vi.fn<(id: string) => Promise<FleetPromoteOutcome>>(async () => ({
      ok: false,
      error: {
        kind: "promotion",
        code: "promotion_verification_failed",
        reason: "project_directory_unavailable",
      },
    }));
    const host = mount(() => <FleetSidebarSection state={liveState()} onPromote={onPromote} />);
    (host.querySelector('[aria-label="Open web as workspace"]') as HTMLButtonElement).click();
    (host.querySelector(".fleet-sidebar__dialog-confirm") as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(host.querySelector('[role="alert"]')?.textContent).toContain(
        "None of the session's directories still exist",
      ),
    );
    expect(host.querySelector('[role="dialog"]')).toBeTruthy();
  });

  describe("promoteFailureSentence", () => {
    it("maps each promotion verdict code to a distinct, non-generic sentence", () => {
      const codes = [
        "session_not_found",
        "session_not_adopted",
        "session_internal",
        "workspace_conflict",
        "stamp_failed",
        "operation_conflict",
        "operation_capacity",
        "daemon_instance_mismatch",
      ] as const;
      const sentences = codes.map((code) => promoteFailureSentence({ kind: "promotion", code }));
      for (const sentence of sentences) {
        expect(sentence.length).toBeGreaterThan(0);
        expect(sentence).not.toBe("The session could not be opened as a workspace.");
      }
      // Each code produces a distinct sentence — the mapping is not a stub.
      expect(new Set(sentences).size).toBe(codes.length);
    });

    it("maps known verification sub-reasons and falls back for unknown ones", () => {
      expect(
        promoteFailureSentence({
          kind: "promotion",
          code: "promotion_verification_failed",
          reason: "project_directory_unavailable",
        }),
      ).toContain("directories still exist");
      // An unknown sub-reason never leaks the raw token.
      const unknown = promoteFailureSentence({
        kind: "promotion",
        code: "promotion_verification_failed",
        reason: "some_future_reason",
      });
      expect(unknown).not.toContain("some_future_reason");
      expect(unknown.length).toBeGreaterThan(0);
    });

    it("passes a capability error's own reason through and defaults when absent", () => {
      expect(
        promoteFailureSentence({ code: "request-timeout", reason: "The request timed out." }),
      ).toBe("The request timed out.");
      expect(promoteFailureSentence(undefined)).toBe(
        "The session could not be opened as a workspace.",
      );
    });
  });

  it("shows an honest empty state and never a broken fleet block", () => {
    const empty: DesktopFleetCatalogState = {
      status: "live",
      generation: 1,
      daemon: DAEMON,
      snapshot: {
        daemon: DAEMON,
        catalog: { version: 1, daemon: DAEMON, sessions: [] },
        updatedAt: 0,
      },
    };
    const host = mount(() => (
      <FleetSidebarSection state={empty} onPromote={async () => ({ ok: true })} />
    ));
    expect(text(host)).toContain("No adopted sessions yet.");
  });

  it("shows a quiet unavailable line with no session rows when the catalog is unavailable", () => {
    const degraded: DesktopFleetCatalogState = {
      status: "degraded",
      generation: 1,
      daemon: DAEMON,
      snapshot: null,
      code: "daemon-unavailable",
      reason: "The canonical daemon is unavailable.",
    };
    const host = mount(() => (
      <FleetSidebarSection state={degraded} onPromote={async () => ({ ok: true })} />
    ));
    expect(text(host)).toContain("Fleet unavailable");
    expect(host.querySelector(".fleet-sidebar__session")).toBeNull();
  });
});

describe("FleetSidebarSection row menu", () => {
  const OPEN_ID = "session.aaaaaaaaaaaaaaaa";

  function rightClick(row: Element): void {
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 30, clientY: 40 }));
    // The release that ends the opening gesture arms the menu.
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  }

  function rowFor(host: HTMLElement, label: string): Element {
    const row = Array.from(host.querySelectorAll(".fleet-sidebar__session-head")).find(
      (candidate) => candidate.textContent?.includes(label),
    );
    if (!row) throw new Error(`no fleet row for ${label}`);
    return row;
  }

  function menuItem(id: string): HTMLButtonElement {
    const element = document.querySelector<HTMLButtonElement>(`[data-context-menu-item="${id}"]`);
    if (!element) throw new Error(`no menu item ${id}`);
    return element;
  }

  function click(element: Element): void {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  }

  it("refuses a closed session's verbs with the one action that fixes it", () => {
    const host = mount(() => (
      <FleetSidebarSection
        state={liveState()}
        openSessionId={OPEN_ID}
        workspaceConnected
        onPromote={async () => ({ ok: true })}
      />
    ));
    rightClick(rowFor(host, "api"));
    expect(menuItem(SURFACE_MENU_IDS.openSession).dataset.disabled).toBe("false");
    expect(menuItem("session.kill").dataset.disabled).toBe("true");
    expect(menuItem("session.kill").textContent).toContain(
      "Open this session as a workspace first",
    );
  });

  it("kills the open session only after a second click", () => {
    const onSessionVerb = vi.fn();
    const host = mount(() => (
      <FleetSidebarSection
        state={liveState()}
        openSessionId={OPEN_ID}
        workspaceConnected
        onPromote={async () => ({ ok: true })}
        onSessionVerb={onSessionVerb}
      />
    ));
    rightClick(rowFor(host, "web"));
    click(menuItem("session.kill"));
    expect(onSessionVerb).not.toHaveBeenCalled();
    click(menuItem("session.kill"));
    expect(onSessionVerb).toHaveBeenCalledWith(
      "session.kill",
      expect.objectContaining({ sessionId: OPEN_ID }),
    );
  });

  it("renames the open session through an inline field on its own row", () => {
    const onSessionVerb = vi.fn();
    const host = mount(() => (
      <FleetSidebarSection
        state={liveState()}
        openSessionId={OPEN_ID}
        workspaceConnected
        onPromote={async () => ({ ok: true })}
        onSessionVerb={onSessionVerb}
      />
    ));
    rightClick(rowFor(host, "web"));
    click(menuItem("session.rename"));
    const field = host.querySelector<HTMLInputElement>(".fleet-sidebar__rename input")!;
    expect(field.value).toBe("web");
    field.value = "frontend";
    field.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(onSessionVerb).toHaveBeenCalledWith(
      "session.rename",
      expect.objectContaining({ sessionId: OPEN_ID }),
      { name: "frontend" },
    );
  });

  it("opens the promote dialog from the menu's own open item", () => {
    const host = mount(() => (
      <FleetSidebarSection state={liveState()} onPromote={async () => ({ ok: true })} />
    ));
    rightClick(rowFor(host, "web"));
    click(menuItem(SURFACE_MENU_IDS.openSession));
    expect(host.querySelector('[role="dialog"]')).toBeTruthy();
  });
});
