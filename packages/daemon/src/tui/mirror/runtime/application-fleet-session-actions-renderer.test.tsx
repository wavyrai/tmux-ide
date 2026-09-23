/* @jsxImportSource @opentui/solid */
import { expect, it } from "bun:test";
import { createSignal } from "solid-js";
import { MouseButtons } from "@opentui/core/testing";
import {
  ApplicationFleetSessionActions,
  type FleetSessionActionPorts,
} from "./application-fleet-session-actions.tsx";
import type { ApplicationPaletteCommand } from "./application-palette-input.ts";
import { createSemanticThemeSnapshot } from "../theme.ts";
import { renderForTest } from "../testing/renderer-harness.test.ts";
import { KeyboardRouteProvider, createKeyboardRouteOwner } from "../ui/keyboard-router.tsx";

const daemonInstanceId = "11111111-1111-4111-8111-111111111111";
const liveSessionId = `live-session.${"a".repeat(20)}`;
const session: ApplicationPaletteCommand = {
  kind: "open-session",
  sessionName: "work",
  label: "work",
  fleet: { machineId: "mini", hostLabel: "Mini", daemonInstanceId, liveSessionId },
};
it("requires exact confirmation, routes close to the selected host, and avoids duplicate submit", async () => {
  const owner = createKeyboardRouteOwner();
  const modes: boolean[] = [];
  const calls: unknown[] = [];
  const handle = {
    read: () => ({ instanceId: daemonInstanceId }),
    endpoint: () => ({ state: "ready", epoch: 1 }),
  };
  const ports = {
    getMachine: (id: string) => {
      expect(id).toBe("mini");
      return handle;
    },
    routing: async () => ({ liveSessions: [{ sessionName: "work", liveSessionId }] }),
    create: async () => null,
    close: async (route: unknown, target: unknown) => {
      calls.push([route, target]);
      return { outcome: "applied" };
    },
  } as unknown as FleetSessionActionPorts;
  const setup = await renderForTest(
    () => (
      <KeyboardRouteProvider owner={owner}>
        <ApplicationFleetSessionActions
          command={session}
          width={80}
          height={24}
          theme={createSemanticThemeSnapshot({ mode: "dark" })}
          active={true}
          onModalChange={(value) => modes.push(value)}
          ports={ports}
        />
      </KeyboardRouteProvider>
    ),
    { width: 80, height: 24 },
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
  let rows = setup.captureCharFrame().split("\n");
  const y = rows.findIndex((row) => row.includes("Close session"));
  await setup.mockMouse.click(rows[y]!.indexOf("Close session") + 2, y, MouseButtons.LEFT);
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("Close session on Mini");
  key("enter");
  expect(calls).toHaveLength(0);
  expect(key("y")).toBe(false);
  await setup.mockInput.typeText("yes");
  key("enter");
  key("enter");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await setup.renderOnce();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual([handle, { daemonInstanceId, liveSessionId, sessionName: "work" }]);
  expect(setup.captureCharFrame()).toContain("Closed work on Mini");
  expect(modes.at(-1)).toBe(false);
  setup.renderer.destroy();
  owner.dispose();
});

it("cancels confirmation when the selected incarnation changes", async () => {
  const owner = createKeyboardRouteOwner();
  const [command, setCommand] = createSignal(session);
  let modal = false;
  const setup = await renderForTest(
    () => (
      <KeyboardRouteProvider owner={owner}>
        <ApplicationFleetSessionActions
          command={command()}
          width={80}
          height={24}
          theme={createSemanticThemeSnapshot({ mode: "dark" })}
          active={true}
          onModalChange={(value) => (modal = value)}
        />
      </KeyboardRouteProvider>
    ),
    { width: 80, height: 24 },
  );
  await setup.renderOnce();
  const rows = setup.captureCharFrame().split("\n");
  const y = rows.findIndex((row) => row.includes("Close session"));
  await setup.mockMouse.click(rows[y]!.indexOf("Close session") + 2, y, MouseButtons.LEFT);
  await setup.renderOnce();
  expect(modal).toBe(true);
  setCommand({
    ...session,
    fleet: { ...session.fleet!, liveSessionId: `live-session.${"b".repeat(20)}` },
  });
  await setup.renderOnce();
  expect(modal).toBe(false);
  expect(setup.captureCharFrame()).not.toContain("Type yes");
  setup.renderer.destroy();
  owner.dispose();
});

it("creates on an empty host without attaching and disables session close", async () => {
  const owner = createKeyboardRouteOwner();
  const created: unknown[] = [];
  const handle = {
    read: () => ({ instanceId: daemonInstanceId }),
    endpoint: () => ({ state: "ready", epoch: 1 }),
  };
  const ports = {
    getMachine: () => handle,
    routing: async () => ({ liveSessions: [] }),
    create: async (route: unknown, name: string) => {
      created.push([route, name]);
      return { outcome: "created", displayName: name };
    },
    close: async () => {
      throw new Error("Must not close a host");
    },
  } as unknown as FleetSessionActionPorts;
  const command: ApplicationPaletteCommand = {
    kind: "open-machine",
    sessionName: "",
    label: "Mini",
    fleet: { machineId: "mini", hostLabel: "Mini", daemonInstanceId, liveSessionId: "" },
  };
  const setup = await renderForTest(
    () => (
      <KeyboardRouteProvider owner={owner}>
        <ApplicationFleetSessionActions
          command={command}
          width={80}
          height={24}
          theme={createSemanticThemeSnapshot({ mode: "dark" })}
          active={true}
          initialName="scratch"
          onModalChange={() => {}}
          ports={ports}
        />
      </KeyboardRouteProvider>
    ),
    { width: 80, height: 24 },
  );
  await setup.renderOnce();
  owner.route({
    name: "n",
    eventType: "press",
    ctrl: true,
    meta: false,
    shift: false,
    preventDefault() {},
    stopPropagation() {},
  });
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("New session on Mini");
  expect(setup.captureCharFrame()).toContain("scratch");
  owner.route({
    name: "enter",
    eventType: "press",
    ctrl: false,
    meta: false,
    shift: false,
    preventDefault() {},
    stopPropagation() {},
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await setup.renderOnce();
  expect(created).toEqual([[handle, "scratch"]]);
  expect(setup.captureCharFrame()).toContain("Created on Mini");
  setup.renderer.destroy();
  owner.dispose();
});

it("requires confirmation before closing a nondefault server session", async () => {
  const keyboard = createKeyboardRouteOwner();
  const modes: boolean[] = [];
  const selected = {
    ...session,
    fleet: {
      ...session.fleet!,
      server: {
        serverId: `tmux-server.${"b".repeat(32)}`,
        generation: "22222222-2222-4222-8222-222222222222",
      },
    },
  } as ApplicationPaletteCommand;
  const setup = await renderForTest(
    () => (
      <KeyboardRouteProvider owner={keyboard}>
        <ApplicationFleetSessionActions
          command={selected}
          width={80}
          height={24}
          theme={createSemanticThemeSnapshot({ mode: "dark" })}
          active={true}
          onModalChange={(value) => modes.push(value)}
        />
      </KeyboardRouteProvider>
    ),
    { width: 80, height: 24 },
  );
  await setup.renderOnce();
  for (const name of ["x"])
    keyboard.route({
      name,
      eventType: "press",
      ctrl: true,
      meta: false,
      shift: false,
      preventDefault() {},
      stopPropagation() {},
    });
  await setup.renderOnce();
  expect(modes).toContain(true);
});

it("creates on the explicitly selected server without querying the default catalog", async () => {
  const keyboard = createKeyboardRouteOwner();
  const calls: unknown[][] = [];
  const server = {
    serverId: `tmux-server.${"b".repeat(32)}`,
    generation: "22222222-2222-4222-8222-222222222222",
  };
  const selected = {
    ...session,
    fleet: { ...session.fleet!, server },
  } as ApplicationPaletteCommand;
  const handle = {
    read: () => ({ instanceId: daemonInstanceId }),
    endpoint: () => ({ state: "ready", epoch: 1 }),
  };
  const ports = {
    getMachine: () => handle,
    routing: async () => {
      throw Error("Default catalog must not be consulted");
    },
    create: async (...args: unknown[]) => {
      calls.push(args);
      return { outcome: "created" };
    },
    close: async () => null,
  } as unknown as FleetSessionActionPorts;
  const setup = await renderForTest(
    () => (
      <KeyboardRouteProvider owner={keyboard}>
        <ApplicationFleetSessionActions
          command={selected}
          initialName="scratch"
          width={80}
          height={24}
          theme={createSemanticThemeSnapshot({ mode: "dark" })}
          active={true}
          onModalChange={() => {}}
          ports={ports}
        />
      </KeyboardRouteProvider>
    ),
    { width: 80, height: 24 },
  );
  await setup.renderOnce();
  keyboard.route({
    name: "n",
    eventType: "press",
    ctrl: true,
    meta: false,
    shift: false,
    preventDefault() {},
    stopPropagation() {},
  });
  await setup.renderOnce();
  keyboard.route({
    name: "return",
    eventType: "press",
    ctrl: false,
    meta: false,
    shift: false,
    preventDefault() {},
    stopPropagation() {},
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await setup.renderOnce();
  expect(calls).toEqual([[handle, "scratch", server]]);
  expect(setup.captureCharFrame()).toContain("Created on Mini");
});
