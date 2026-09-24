/* @jsxImportSource @opentui/solid */
import { MouseButtons } from "@opentui/core/testing";
import { useKeyboard } from "@opentui/solid";
import { describe, expect, it } from "bun:test";
import { createSignal, onCleanup } from "solid-js";
import { createSemanticThemeSnapshot } from "../theme.ts";
import { renderForTest, expectFrameBounds } from "../testing/renderer-harness.test.ts";
import { createKeyboardRouteOwner, KeyboardRouteProvider } from "../ui/keyboard-router.tsx";
import { createApplicationHomeFleetOwner } from "./application-home-fleet.ts";
import type { ApplicationMachineAgentGroup } from "./application-machine-agents.ts";
import { HomeAgentRoster } from "./application-home-agent-roster.tsx";
import { createHomeAgentSelectionOwner } from "./application-home-agent-selection.ts";
import type { HomeAgentRow, HomeAgentSnapshot } from "./application-home-agents.ts";

function row(name: string, overrides: Partial<HomeAgentRow> = {}): HomeAgentRow {
  return {
    key: name,
    sessionKey: "live-session",
    sessionName: "tmux-ide",
    liveSessionId: "$1",
    daemonInstanceId: "daemon-1",
    agentId: name,
    paneId: `pane.${name}`,
    name,
    harness: "codex",
    activity: "running",
    attention: false,
    projectName: "tmux-ide",
    ...overrides,
  };
}

function snapshot(
  rows: readonly HomeAgentRow[],
  overrides: Partial<HomeAgentSnapshot> = {},
): HomeAgentSnapshot {
  return {
    phase: "live",
    rows,
    observedSessions: 3,
    totalSessions: 3,
    loadingSessions: 0,
    unavailableSessions: 0,
    truncatedSessions: 0,
    refreshingSessionKeys: [],
    unavailableSessionKeys: [],
    note: null,
    ...overrides,
  };
}

describe("flat Home agent roster", () => {
  for (const mode of ["dark", "light"] as const) {
    it.each([
      [76, 15],
      [116, 31],
      [32, 10],
      [8, 6],
    ])("renders scoped cells at %ix%i in " + mode, async (width, height) => {
      const data = snapshot([
        row("quiet-otter", { activity: "waiting", attention: true }),
        row("分析 Café 👨‍💻", { sessionName: "other-project" }),
        row("disconnected-agent", { activity: "disconnected" }),
      ]);
      const setup = await renderForTest(
        () => (
          <HomeAgentRoster
            theme={createSemanticThemeSnapshot({ mode })}
            width={width}
            height={height}
            snapshot={data}
            selection={{ selectedKey: "quiet-otter", scrollOffset: 0 }}
            inputActive
            onSelect={() => undefined}
            onMove={() => undefined}
            onViewport={() => undefined}
            onOpen={() => undefined}
          />
        ),
        { width, height },
      );
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expectFrameBounds(frame, width, height);
      expect(frame).not.toContain("\uFFFD");
      if (width >= 76) {
        expect(frame).toContain("3 observed agents · 1 needs attention · 1 working");
        expect(frame).toContain("Scope: 3 of 3 sessions observed");
        expect(frame).toContain("Session");
        expect(frame).toContain("! blocked");
        expect(frame).toContain("disconnected");
        expect(frame).toContain("分析 Café 👨‍💻");
      }
      if (width === 32) {
        expect(frame).not.toContain("Session");
        expect(frame).toContain("tmux-ide · Enter open");
      }
      setup.renderer.destroy();
    });
  }

  it("uses singular labels for one observed agent needing attention", async () => {
    const data = snapshot([row("quiet-otter", { activity: "waiting", attention: true })]);
    const setup = await renderForTest(
      () => (
        <HomeAgentRoster
          theme={createSemanticThemeSnapshot({ mode: "dark" })}
          width={80}
          height={12}
          snapshot={data}
          selection={{ selectedKey: "quiet-otter", scrollOffset: 0 }}
          inputActive
          onSelect={() => undefined}
          onMove={() => undefined}
          onViewport={() => undefined}
          onOpen={() => undefined}
        />
      ),
      { width: 80, height: 12 },
    );
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("1 observed agent · 1 needs attention · 0 working");
    setup.renderer.destroy();
  });

  it("routes keyboard, pointer and wheel through resident selection without hover activation", async () => {
    const selection = createHomeAgentSelectionOwner();
    const data = snapshot(Array.from({ length: 12 }, (_, i) => row(`agent-${i}`)));
    selection.setRows(data.rows);
    const calls: string[] = [];
    let deactivate = () => undefined;
    let setRows = (_rows: HomeAgentSnapshot) => undefined;
    const setup = await renderForTest(
      () => {
        const owner = createKeyboardRouteOwner();
        const [state, setState] = createSignal(selection.snapshot());
        const [active, setActive] = createSignal(true);
        const [current, setCurrent] = createSignal(data);
        deactivate = () => setActive(false);
        setRows = (next) => {
          selection.setRows(next.rows);
          setCurrent(next);
        };
        const stop = selection.subscribe(setState);
        onCleanup(() => {
          stop();
          owner.dispose();
        });
        useKeyboard((event) => owner.route(event));
        return (
          <KeyboardRouteProvider owner={owner}>
            <HomeAgentRoster
              theme={createSemanticThemeSnapshot({ mode: "dark" })}
              width={76}
              height={10}
              snapshot={current()}
              selection={state()}
              inputActive={active()}
              onSelect={selection.select}
              onMove={selection.move}
              onViewport={selection.setViewport}
              onOpen={(agent, source) => calls.push(`${agent.key}:${source}`)}
            />
          </KeyboardRouteProvider>
        );
      },
      { width: 76, height: 10 },
    );
    await setup.renderOnce();
    await setup.mockMouse.moveTo(5, 5);
    expect(selection.snapshot().selectedKey).toBe("agent-0");
    expect(calls).toEqual([]);
    await setup.mockInput.pressArrow("down");
    await setup.renderOnce();
    expect(selection.snapshot().selectedKey).toBe("agent-1");
    await setup.mockInput.pressEnter();
    expect(calls).toEqual(["agent-1:keyboard"]);
    const firstRowY = setup
      .captureCharFrame()
      .split("\n")
      .findIndex((line) => line.includes("agent-0"));
    await setup.mockMouse.click(6, firstRowY, MouseButtons.LEFT);
    expect(calls).toEqual(["agent-1:keyboard", "agent-0:mouse"]);
    await setup.mockMouse.scroll(6, 5, "down");
    expect(selection.snapshot().selectedKey).toBe("agent-1");
    selection.move(11);
    await setup.renderOnce();
    expect(selection.snapshot().scrollOffset).toBe(7);
    expect(setup.captureCharFrame()).toContain("agent-11");
    setRows(snapshot([...data.rows].reverse()));
    await setup.renderOnce();
    expect(selection.snapshot().selectedKey).toBe("agent-11");
    expect(setup.captureCharFrame()).toContain("agent-11");
    deactivate();
    await setup.renderOnce();
    await setup.mockInput.pressEnter();
    await setup.mockInput.pressArrow("down");
    expect(calls).toHaveLength(2);
    expect(selection.snapshot().selectedKey).toBe("agent-11");
    setup.renderer.destroy();
    selection.dispose();
  });

  it.each(["loading", "partial", "unavailable", "live"] as const)(
    "distinguishes %s without agents from a complete empty fleet",
    async (phase) => {
      const data = snapshot([], {
        phase,
        observedSessions: phase === "live" ? 3 : 0,
        unavailableSessions: phase === "unavailable" ? 3 : 0,
      });
      const setup = await renderForTest(
        () => (
          <HomeAgentRoster
            theme={createSemanticThemeSnapshot({ mode: "dark" })}
            width={76}
            height={12}
            snapshot={data}
            selection={{ selectedKey: null, scrollOffset: 0 }}
            inputActive
            onSelect={() => undefined}
            onMove={() => undefined}
            onViewport={() => undefined}
            onOpen={() => undefined}
          />
        ),
        { width: 76, height: 12 },
      );
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      if (phase === "live") expect(frame).toContain("No agents reported");
      else expect(frame).not.toContain("No agents reported");
      if (phase === "unavailable") expect(frame).toContain("not an empty fleet");
      if (phase === "partial") expect(frame).toContain("partial");
      if (phase === "loading") expect(frame).toContain("Loading agent overview");
      setup.renderer.destroy();
    },
  );

  it("keeps stale identity visible but prevents activation and offers keyboard/pointer recovery", async () => {
    const data = snapshot([row("last-known")], {
      phase: "partial",
      observedSessions: 0,
      totalSessions: 4,
      unavailableSessions: 1,
      truncatedSessions: 3,
      unavailableSessionKeys: ["live-session"],
    });
    const calls: string[] = [];
    const setup = await renderForTest(
      () => {
        const owner = createKeyboardRouteOwner();
        onCleanup(() => owner.dispose());
        useKeyboard((event) => owner.route(event));
        return (
          <KeyboardRouteProvider owner={owner}>
            <HomeAgentRoster
              theme={createSemanticThemeSnapshot({ mode: "dark" })}
              width={76}
              height={12}
              snapshot={data}
              selection={{ selectedKey: "last-known", scrollOffset: 0 }}
              inputActive
              onSelect={() => calls.push("select")}
              onMove={() => undefined}
              onViewport={() => undefined}
              onOpen={() => calls.push("open")}
              onRetry={() => calls.push("retry")}
              onLoadMore={() => calls.push("more")}
            />
          </KeyboardRouteProvider>
        );
      },
      { width: 76, height: 12 },
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("last seen");
    expect(frame).toContain("0 working");
    expect(frame).toContain("last observed");
    await setup.mockInput.pressEnter();
    await setup.mockMouse.click(5, 4, MouseButtons.LEFT);
    expect(calls).toEqual([]);
    await setup.mockInput.pressKey("r");
    await setup.mockInput.pressKey("m");
    const lines = frame.split("\n");
    const y = lines.findIndex((line) => line.includes("Retry r"));
    await setup.mockMouse.click(lines[y]!.indexOf("Retry r"), y, MouseButtons.LEFT);
    await setup.mockMouse.click(lines[y]!.indexOf("Load more m"), y, MouseButtons.LEFT);
    expect(calls).toEqual(["retry", "more", "retry", "more"]);
    setup.renderer.destroy();
  });
});

it("exposes fleet scope and routes machine/attention filters only while Home owns input", async () => {
  const calls: string[] = [];
  const routes = createKeyboardRouteOwner();
  const setup = await renderForTest(
    () => {
      useKeyboard((event) => routes.route(event));
      return (
        <KeyboardRouteProvider owner={routes}>
          <HomeAgentRoster
            theme={createSemanticThemeSnapshot({ mode: "light" })}
            width={100}
            height={12}
            snapshot={snapshot([
              row("Claude", { machineLabel: "Spark", serverLabel: "build", sessionName: "work" }),
            ])}
            selection={{ selectedKey: "Claude", scrollOffset: 0 }}
            inputActive={true}
            filterLabel="All machines · All agents"
            onCycleMachine={() => calls.push("machine")}
            onToggleAttention={() => calls.push("attention")}
            onSelect={() => {}}
            onMove={() => {}}
            onViewport={() => {}}
            onOpen={() => {}}
          />
        </KeyboardRouteProvider>
      );
    },
    { width: 100, height: 12 },
  );
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("Spark / build / work");
  expect(setup.captureCharFrame()).toContain("All machines · All agents");
  await setup.mockInput.pressKey("f");
  await setup.mockInput.pressKey("a");
  expect(calls).toEqual(["machine", "attention"]);
  setup.renderer.destroy();
});

it("searches resident fleet rows, retains identity, and isolates editing from shortcuts and overlays", async () => {
  const routes = createKeyboardRouteOwner();
  const [active, setActive] = createSignal(true);
  const calls: string[] = [];
  const makeGroup = (): ApplicationMachineAgentGroup => ({
    machineId: "spark",
    available: true,
    agents: ["one", "two"].map((id) => ({
      ...row(id),
      id,
      machineId: "spark",
      name: id === "one" ? "Claude" : "Codex",
      sessionName: id === "one" ? "research" : "rendering",
      paneId: `pane.${id}`,
      activity: "running" as const,
    })),
  });
  let groups = [makeGroup()];
  let update!: (groups: readonly ApplicationMachineAgentGroup[]) => void;
  let presentation!: ReturnType<typeof createApplicationHomeFleetOwner>["presentation"];
  const setup = await renderForTest(
    () => {
      const owner = createApplicationHomeFleetOwner({
        catalog: {
          getSnapshot: () => ({
            selectedMachineId: "spark",
            groups: [
              {
                id: "spark",
                label: "Spark",
                state: "ready",
                note: null,
                sessions: [],
              },
            ],
          }),
          subscribe: () => () => {},
        },
        agents: {
          getSnapshot: () => groups,
          subscribe(listener) {
            update = listener;
            return () => {};
          },
        },
        inputActive: active,
        open: (machine, agent) => {
          calls.push(`${machine}/${agent.id}/${agent.paneId}`);
        },
      });
      presentation = owner.presentation;
      return (
        <KeyboardRouteProvider owner={routes}>
          <HomeAgentRoster
            theme={createSemanticThemeSnapshot({ mode: "dark" })}
            width={96}
            height={24}
            snapshot={presentation.agentRoster!}
            selection={presentation.agentSelection!}
            query={presentation.agentQuery}
            onQueryChange={presentation.onAgentQueryChange}
            inputActive={active()}
            onSelect={presentation.onSelectAgent!}
            onMove={presentation.onMoveAgent!}
            onViewport={presentation.onAgentViewport!}
            onOpen={presentation.onOpenAgent!}
            onCycleMachine={() => calls.push("filter")}
            onToggleAttention={() => calls.push("attention")}
          />
        </KeyboardRouteProvider>
      );
    },
    { width: 96, height: 24 },
  );
  const key = (name: string, eventType = "press") =>
    routes.route({
      name,
      eventType,
      ctrl: false,
      meta: false,
      shift: false,
      preventDefault() {},
      stopPropagation() {},
    });
  try {
    await setup.renderOnce();
    key("/");
    for (const c of "rendering") key(c);
    await setup.renderOnce();
    expect(presentation.agentRoster!.rows.map((row) => row.key)).toEqual(["two"]);
    expect(presentation.agentSelection!.selectedKey).toBe("two");
    expect(calls).toEqual([]);
    groups = [{ ...makeGroup(), agents: makeGroup().agents.slice().reverse() }];
    update(groups);
    await setup.renderOnce();
    expect(presentation.agentSelection!.selectedKey).toBe("two");
    key("enter", "repeat");
    expect(calls).toEqual([]);
    key("enter");
    expect(calls).toEqual(["spark/two/pane.two"]);
    setActive(false);
    expect(routes.routePaste(new TextEncoder().encode("ignored"))).toBe(false);
    key("f");
    expect(presentation.agentQuery).toBe("rendering");
    setActive(true);
    key("escape");
    expect(routes.routePaste(new TextEncoder().encode("research"))).toBe(true);
    await setup.renderOnce();
    expect(presentation.agentSelection!.selectedKey).toBe("one");
    key("escape");
    key("escape");
    key("a");
    expect(calls.at(-1)).toBe("attention");
    await setup.renderOnce();
    expectFrameBounds(setup.captureCharFrame(), 96, 24);
    expect(setup.captureCharFrame()).not.toContain("›");
  } finally {
    setup.renderer.destroy();
    routes.dispose();
  }
});

it("does not open a search selection when a short viewport cannot display its row", async () => {
  const routes = createKeyboardRouteOwner();
  const calls: string[] = [];
  const setup = await renderForTest(
    () => (
      <KeyboardRouteProvider owner={routes}>
        <HomeAgentRoster
          theme={createSemanticThemeSnapshot({ mode: "light" })}
          width={20}
          height={6}
          snapshot={snapshot([row("hidden")])}
          selection={{ selectedKey: "hidden", scrollOffset: 0 }}
          query=""
          onQueryChange={() => {}}
          inputActive
          onSelect={() => {}}
          onMove={() => {}}
          onViewport={() => {}}
          onOpen={() => calls.push("opened")}
        />
      </KeyboardRouteProvider>
    ),
    { width: 20, height: 6 },
  );
  try {
    await setup.renderOnce();
    for (const name of ["/", "enter"])
      routes.route({
        name,
        eventType: "press",
        ctrl: false,
        meta: false,
        shift: false,
        preventDefault() {},
        stopPropagation() {},
      });
    expect(calls).toEqual([]);
    expectFrameBounds(setup.captureCharFrame(), 20, 6);
  } finally {
    setup.renderer.destroy();
    routes.dispose();
  }
});
