import { ApplicationCatalogShell } from "./application-shell-catalog.tsx";
/* @jsxImportSource @opentui/solid */
import { MouseButtons } from "@opentui/core/testing";
import { describe, expect, it } from "bun:test";
import { createSignal } from "solid-js";
import { createSemanticThemeSnapshot } from "../theme.ts";
import { renderForTest } from "../testing/renderer-harness.test.ts";
import { KeyboardRouteProvider, createKeyboardRouteOwner } from "../ui/keyboard-router.tsx";
import {
  ApplicationMachineSidebar,
  type ApplicationMachineGroup,
} from "./application-machine-sidebar.tsx";

describe("machine sidebar", () => {
  it("keeps identical session names scoped, shows status, and blocks stale sessions", async () => {
    const calls: string[][] = [];
    const groups: ApplicationMachineGroup[] = [
      {
        id: "local",
        label: "Local",
        state: "ready",
        sessions: [{ id: "a", name: "work", paneCount: 2 }],
      },
      {
        id: "remote",
        label: "Server",
        state: "ready",
        sessions: [{ id: "a", name: "work", paneCount: 3 }],
      },
      {
        id: "offline",
        label: "Laptop",
        state: "disconnected",
        sessions: [{ id: "a", name: "old", paneCount: 1 }],
      },
    ];
    const setup = await renderForTest(
      () => (
        <ApplicationMachineSidebar
          width={30}
          height={12}
          theme={createSemanticThemeSnapshot({ mode: "dark" })}
          model={{
            groups: () => groups,
            activeMachineId: () => "local",
            activeSessionName: () => "work",
            onOpen: (machine, session) => calls.push([machine, session]),
            onSelectMachine: (machine) => calls.push([machine]),
          }}
        />
      ),
      { width: 30, height: 12 },
    );
    await setup.renderOnce();
    const lines = setup.captureCharFrame().split("\n");
    expect(lines.join("\n")).toContain("offline");
    const work = lines.flatMap((line, index) => (line.includes("work") ? [index] : []));
    expect(work.length).toBe(2);
    await setup.mockMouse.click(5, work[1]!, MouseButtons.LEFT);
    const old = lines.findIndex((line) => line.includes("old"));
    await setup.mockMouse.click(5, old, MouseButtons.LEFT);
    expect(calls).toEqual([["remote", "work"]]);
    setup.renderer.destroy();
  });

  it("navigates with keys, collapses without hiding the active child, and scrolls within bounds", async () => {
    const owner = createKeyboardRouteOwner();
    const opened: string[] = [];
    const [focused, setFocused] = createSignal(true);
    const groups: ApplicationMachineGroup[] = [
      {
        id: "local",
        label: "Local",
        state: "ready",
        sessions: Array.from({ length: 30 }, (_, i) => ({
          id: String(i),
          name: `session-${i}`,
          paneCount: 1,
        })),
      },
    ];
    const setup = await renderForTest(
      () => (
        <KeyboardRouteProvider owner={owner}>
          <ApplicationMachineSidebar
            width={30}
            height={8}
            theme={createSemanticThemeSnapshot({ mode: "dark" })}
            model={{
              groups: () => groups,
              activeMachineId: () => "local",
              activeSessionName: () => "session-0",
              focused,
              onOpen: (_machine, session) => opened.push(session),
              onSelectMachine: () => {},
              onBlur: () => setFocused(false),
            }}
          />
        </KeyboardRouteProvider>
      ),
      { width: 30, height: 8 },
    );
    const key = (name: string) =>
      owner.route({
        name,
        eventType: "press",
        ctrl: false,
        meta: false,
        shift: false,
        preventDefault() {},
        stopPropagation() {},
      });
    await setup.renderOnce();
    key("home");
    key("left");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("session-0");
    expect(setup.captureCharFrame()).not.toContain("session-1");
    key("right");
    key("end");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("session-29");
    key("enter");
    expect(opened).toEqual(["session-29"]);
    key("escape");
    expect(focused()).toBe(false);
    setup.renderer.destroy();
    owner.dispose();
  });
});

for (const surface of ["home", "terminals"] as const) {
  it(`shows grouped navigation in the catalog ${surface} sidebar`, async () => {
    const setup = await renderForTest(
      () => (
        <ApplicationCatalogShell
          dimensions={() => ({ width: 80, height: 20 })}
          surface={() => surface}
          sessions={["work"]}
          selectedSession={() => 0}
          bootstrapNote={() => null}
          paletteOpen={() => false}
          theme={createSemanticThemeSnapshot({ mode: "dark" })}
          onOpenSurface={() => {}}
          onOpenSession={() => {}}
          onSetPaletteOpen={() => {}}
          machineSidebar={{
            groups: () => [
              {
                id: "server",
                label: "My server",
                state: "ready",
                sessions: [{ id: "a", name: "work", paneCount: 2 }],
              },
            ],
            activeMachineId: () => "server",
            activeSessionName: () => "work",
            onOpen: () => {},
            onSelectMachine: () => {},
          }}
        />
      ),
      { width: 80, height: 20 },
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Machines");
    expect(frame).toContain("My server");
    expect(frame.split("\n").filter((line) => line.includes("Machines"))).toHaveLength(1);
    setup.renderer.destroy();
  });
}
