/* @jsxImportSource @opentui/solid */
import { expect, it } from "bun:test";
import { createSignal } from "solid-js";
import { renderForTest } from "../testing/renderer-harness.test.ts";
import { createSemanticThemeSnapshot } from "../theme.ts";
import { KeyboardRouteProvider, createKeyboardRouteOwner } from "../ui/keyboard-router.tsx";
import { ApplicationFleetSwitcher, type FleetSwitcherRow } from "./application-fleet-switcher.tsx";

it("filters across hosts and keeps selection on its identity when rows reorder", async () => {
  const opened: string[] = [];
  const favorite: string[] = [];
  const make = (key: string, disabled = false): FleetSwitcherRow => ({
    key,
    label: "api",
    detail: key,
    favorite: false,
    attention: true,
    disabled,
    canFavorite: true,
    open: () => {
      opened.push(key);
    },
    toggleFavorite: () => {
      favorite.push(key);
    },
  });
  const [rows, setRows] = createSignal([make("mini"), make("gpu", true)]);
  const owner = createKeyboardRouteOwner();
  const setup = await renderForTest(
    () => (
      <KeyboardRouteProvider owner={owner}>
        <ApplicationFleetSwitcher
          open={true}
          attentionOnly={false}
          rows={rows()}
          onClose={() => {}}
          width={70}
          height={18}
          theme={createSemanticThemeSnapshot({ mode: "dark" })}
        />
      </KeyboardRouteProvider>
    ),
    { width: 70, height: 18 },
  );
  const key = (name: string, ctrl = false) =>
    owner.route({
      name,
      eventType: "press",
      ctrl,
      meta: false,
      shift: false,
      preventDefault() {},
      stopPropagation() {},
    });
  await setup.renderOnce();
  key("down");
  key("enter");
  expect(opened).toEqual([]);
  setRows([make("gpu", true), make("mini")]);
  await setup.renderOnce();
  key("enter");
  expect(opened).toEqual([]);
  await setup.mockInput.typeText("mini");
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("1 matches");
  key("f", true);
  key("enter");
  expect(favorite).toEqual(["mini"]);
  expect(opened).toEqual(["mini"]);
  setup.renderer.destroy();
  owner.dispose();
});

it("renders a narrow attention inbox without opening cached inactive agents", async () => {
  const setup = await renderForTest(
    () => (
      <ApplicationFleetSwitcher
        open={true}
        attentionOnly={true}
        rows={[]}
        onClose={() => {}}
        width={30}
        height={10}
        theme={createSemanticThemeSnapshot({ mode: "dark" })}
      />
    ),
    { width: 30, height: 10 },
  );
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("0 matches");
  setup.renderer.destroy();
});
