/* @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import type { DaemonInstanceIdentity } from "@tmux-ide/contracts";

import { FleetSidebarSection, type FleetPromoteOutcome } from "./fleet-sidebar.tsx";
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

  it("keeps the dialog open and shows the reason when promotion fails", async () => {
    const onPromote = vi.fn<(id: string) => Promise<FleetPromoteOutcome>>(async () => ({
      ok: false,
      reason: "The canonical daemon is unavailable.",
    }));
    const host = mount(() => <FleetSidebarSection state={liveState()} onPromote={onPromote} />);
    (host.querySelector('[aria-label="Open web as workspace"]') as HTMLButtonElement).click();
    (host.querySelector(".fleet-sidebar__dialog-confirm") as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(host.querySelector('[role="alert"]')?.textContent).toContain("daemon is unavailable"),
    );
    expect(host.querySelector('[role="dialog"]')).toBeTruthy();
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
