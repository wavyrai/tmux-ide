/* @jsxImportSource @opentui/solid */
import { MouseButtons } from "@opentui/core/testing";
import { useKeyboard } from "@opentui/solid";
import { createSignal, onCleanup } from "solid-js";
import { describe, expect, it } from "bun:test";
import { buildHostedPanelViews } from "../panel-host.ts";
import { SelectableRow, Surface } from "../recipes.tsx";
import { createSemanticThemeSnapshot } from "../theme.ts";
import {
  destroyTestRenderer,
  expectFrameBounds,
  renderForTest,
  stableFrame,
} from "../testing/renderer-harness.test.ts";
import {
  applicationShellHitTest,
  projectApplicationShell,
  type ApplicationShellSession,
} from "./application-shell.ts";
import { ApplicationShell } from "./application-shell.tsx";

const views = buildHostedPanelViews([
  { id: "home", title: "Home", panel: "home" },
  { id: "terminal", title: "Terminal", panel: "terminals" },
  { id: "files", title: "Files", panel: "files" },
  { id: "changes", title: "Changes", panel: "diff" },
  { id: "missions", title: "Missions", panel: "missions" },
]);
const sessions: readonly ApplicationShellSession[] = [
  { name: "tmux-ide", status: "working" },
  { name: "website", status: "blocked" },
  { name: "docs", status: "idle" },
];

async function renderShell(width: number, height: number, disposed?: () => void) {
  const theme = createSemanticThemeSnapshot({ mode: "dark" });
  const events: string[] = [];
  let activeValue = "terminal";
  let messageValue = "ready";

  function Harness() {
    const [active, setActive] = createSignal(activeValue);
    const [message, setMessage] = createSignal(messageValue);
    const projection = () =>
      projectApplicationShell({
        width,
        height,
        preferredSidebarWidth: 28,
        views,
        activeViewId: active(),
        hoveredTabIndex: null,
        attentionViewIds: new Set(["missions"]),
        sessions,
        activeSession: "tmux-ide",
        quitHint: "^q quit",
      });
    const activate = (viewId: string) => {
      activeValue = viewId;
      messageValue = `selected ${viewId}`;
      setActive(viewId);
      setMessage(messageValue);
      events.push(`view:${viewId}`);
    };
    useKeyboard((event) => {
      if (event.name === "right") {
        const index = views.findIndex((view) => view.id === active());
        activate(views[Math.min(views.length - 1, index + 1)]!.id);
      } else if (event.name === "f5") {
        messageValue = "palette";
        setMessage(messageValue);
        events.push("palette");
      }
    });
    onCleanup(() => disposed?.());
    return (
      <box
        width={width}
        height={height}
        overflow="hidden"
        onMouseDown={(event) => {
          const hit = applicationShellHitTest(projection(), event.x, event.y);
          if (hit?.kind === "view") activate(hit.viewId);
          else if (hit?.kind === "session") events.push(`session:${hit.session}`);
          else if (hit?.kind === "palette") {
            messageValue = "palette";
            setMessage(messageValue);
            events.push("palette");
          }
        }}
      >
        <ApplicationShell
          theme={theme}
          projection={projection()}
          project="tmux-ide"
          mode={active()}
          notification={message()}
          help="F5 palette · arrows move · ^q quit"
          note="M31 application workspace"
          rightChips={[
            { id: "context", label: "⧉ tmux-ide ", context: true },
            { id: "mission", label: "!1 blocked ", attention: true },
          ]}
        >
          <Surface
            theme={theme}
            title={`${projection().layout.variant} workspace`}
            focused
            width={projection().content.width}
            height={projection().content.height}
          >
            <SelectableRow
              theme={theme}
              label="Persistent application shell"
              meta={active()}
              width={Math.max(1, projection().content.width - 2)}
              selected
            />
            <SelectableRow
              theme={theme}
              label="PaneFrame lands in the next card"
              meta="M31.2"
              width={Math.max(1, projection().content.width - 2)}
              focused
            />
            <SelectableRow
              theme={theme}
              label="Mission runtime stays harness-neutral"
              meta="contract"
              width={Math.max(1, projection().content.width - 2)}
              attention
              status="blocked"
              tone="blocked"
            />
          </Surface>
        </ApplicationShell>
      </box>
    );
  }

  const setup = await renderForTest(() => <Harness />, { width, height });
  await setup.renderOnce();
  return {
    setup,
    events,
    active: () => activeValue,
    message: () => messageValue,
    projection: () =>
      projectApplicationShell({
        width,
        height,
        preferredSidebarWidth: 28,
        views,
        activeViewId: activeValue,
        hoveredTabIndex: null,
        attentionViewIds: new Set(["missions"]),
        sessions,
        activeSession: "tmux-ide",
        quitHint: "^q quit",
      }),
    frame: () => setup.captureCharFrame(),
  };
}

describe("ApplicationShell OpenTUI renderer", () => {
  it.each([
    [80, 24, "compact"],
    [120, 40, "standard"],
    [200, 60, "wide"],
  ] as const)("records the %sx%s %s acceptance baseline", async (width, height, variant) => {
    const harness = await renderShell(width, height);
    const frame = harness.frame();
    expectFrameBounds(frame, width, height);
    expect(stableFrame(frame)).toMatchSnapshot();
    expect(stableFrame(frame)).toContain(`${variant} workspace`);
    expect(stableFrame(frame)).toContain("M31 application workspace");
    expect(stableFrame(frame)).toContain("F5");
    expect(stableFrame(frame)).toContain("^q quit");
  });

  it("routes keyboard and pointer actions through the harness input owner", async () => {
    const harness = await renderShell(120, 40);
    harness.setup.mockInput.pressArrow("right");
    await harness.setup.renderOnce();
    expect(harness.active()).toBe("files");
    expect(stableFrame(harness.frame())).toContain("selected files");

    const missions = harness.projection().tabs.find((tab) => tab.id === "missions")!;
    await harness.setup.mockMouse.click(
      missions.span.start + Math.floor(missions.span.width / 2),
      0,
      MouseButtons.LEFT,
    );
    await harness.setup.renderOnce();
    expect(harness.active()).toBe("missions");

    const hint = harness.projection().sidebarHint.buttonSpan;
    await harness.setup.mockMouse.click(
      hint.start,
      harness.projection().layout.sidebar.y + harness.projection().layout.sidebar.height - 1,
      MouseButtons.LEFT,
    );
    await harness.setup.renderOnce();
    expect(harness.message()).toBe("palette");
    expect(harness.events).toEqual(["view:files", "view:missions", "palette"]);
  });

  it("destroys the renderer and disposes the Solid root", async () => {
    let disposed = false;
    const harness = await renderShell(80, 24, () => {
      disposed = true;
    });
    destroyTestRenderer(harness.setup);
    expect(disposed).toBe(true);
  });
});
