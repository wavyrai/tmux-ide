/* @jsxImportSource @opentui/solid */
import { BoxRenderable } from "@opentui/core";
import { describe, expect, it } from "bun:test";
import { For, Show, createSignal, onCleanup } from "solid-js";
import {
  destroyTestRenderer,
  expectFrameBounds,
  renderForTest,
  stableFrame,
} from "../testing/renderer-harness.test.ts";

interface StreamRow {
  id: "alpha" | "beta";
  label: string;
}

interface ChurnState {
  width: number;
  outputVersion: number;
  focusedId: StreamRow["id"];
  order: readonly StreamRow[];
  notice: string | null;
}

const ALPHA: StreamRow = { id: "alpha", label: "Agent alpha" };
const BETA: StreamRow = { id: "beta", label: "Agent beta" };

describe("OpenTUI Solid insertion stability", () => {
  it("keeps keyed output rows silent and resident through output, focus, layout, and Show churn", async () => {
    let drive!: (state: ChurnState) => void;
    let disposed = 0;

    function Harness() {
      const [state, setState] = createSignal<ChurnState>({
        width: 48,
        outputVersion: 0,
        focusedId: "alpha",
        order: [ALPHA, BETA],
        notice: null,
      });
      drive = setState;
      onCleanup(() => {
        disposed += 1;
      });
      return (
        <box
          id="insertion-stability-root"
          width={state().width}
          height={6}
          flexDirection="column"
          overflow="hidden"
        >
          <box height={1} flexDirection="row">
            <For each={state().order}>
              {(row) => (
                <text id={`insertion-stability-row:${row.id}`}>
                  {`${state().focusedId === row.id ? "●" : "○"} ${row.label} v${state().outputVersion} `}
                </text>
              )}
            </For>
          </box>
          <Show when={state().notice} fallback={<text id="insertion-stability-idle">idle</text>}>
            {(notice) => <text id="insertion-stability-notice">{notice()}</text>}
          </Show>
        </box>
      );
    }

    const warnings: string[] = [];
    const originalWarn = console.warn;
    const originalError = console.error;
    const captureDiagnostic = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    console.warn = captureDiagnostic;
    console.error = captureDiagnostic;
    const setup = await renderForTest(() => <Harness />, { width: 48, height: 6 });
    const initialRows = new Map(
      ([ALPHA, BETA] as const).map((row) => [
        row.id,
        setup.renderer.root.findDescendantById(`insertion-stability-row:${row.id}`),
      ]),
    );
    expect([...initialRows.values()].every(Boolean)).toBe(true);

    try {
      for (let version = 1; version <= 120; version += 1) {
        const reversed = version % 2 === 1;
        const width = version % 3 === 0 ? 64 : 48;
        const state: ChurnState = {
          width,
          outputVersion: version,
          focusedId: reversed ? "beta" : "alpha",
          order: reversed ? [BETA, ALPHA] : [ALPHA, BETA],
          notice: version % 4 === 0 ? `output ${version}` : null,
        };
        drive(state);
        setup.resize(width, 6);
        await setup.renderOnce();

        const frame = setup.captureCharFrame();
        const stable = stableFrame(frame);
        expectFrameBounds(frame, width, 6);
        expect(stable).toContain(`v${version}`);
        expect(stable).toContain(state.notice ?? "idle");
        const alphaOffset = stable.indexOf(`Agent alpha v${version}`);
        const betaOffset = stable.indexOf(`Agent beta v${version}`);
        expect(alphaOffset).toBeGreaterThanOrEqual(0);
        expect(betaOffset).toBeGreaterThanOrEqual(0);
        expect(reversed ? betaOffset < alphaOffset : alphaOffset < betaOffset).toBe(true);
        for (const row of [ALPHA, BETA] as const) {
          expect(setup.renderer.root.findDescendantById(`insertion-stability-row:${row.id}`)).toBe(
            initialRows.get(row.id),
          );
        }
      }
    } finally {
      console.warn = originalWarn;
      console.error = originalError;
      destroyTestRenderer(setup);
    }

    expect(warnings).toEqual([]);
    expect(disposed).toBe(1);
  });

  it("continues to report direct same-node and genuinely foreign insertBefore anchors", async () => {
    const setup = await renderForTest(
      () => (
        <box id="valid-parent">
          <box id="valid-child" />
        </box>
      ),
      { width: 20, height: 4 },
    );
    await setup.renderOnce();
    const parent = setup.renderer.root.findDescendantById("valid-parent")!;
    const child = setup.renderer.root.findDescendantById("valid-child")!;
    const foreignAnchor = new BoxRenderable(setup.renderer, { id: "foreign-anchor" });
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    try {
      parent.insertBefore(child, child);
      parent.insertBefore(child, foreignAnchor);
    } finally {
      console.warn = originalWarn;
      foreignAnchor.destroy();
      destroyTestRenderer(setup);
    }
    expect(warnings).toEqual([
      "Anchor is the same as the node valid-child being inserted, skipping insertBefore",
      "Anchor with id foreign-anchor does not exist within the parent valid-parent, skipping insertBefore",
    ]);
  });
});
