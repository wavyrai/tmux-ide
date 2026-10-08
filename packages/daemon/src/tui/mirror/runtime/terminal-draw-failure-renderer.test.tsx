/* @jsxImportSource @opentui/solid */
import { expect, it } from "bun:test";
import { createSignal } from "solid-js";
import { CliRenderEvents } from "@opentui/core";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CanonicalTerminalReplicaUpdate } from "@tmux-ide/contracts";
import { createTerminalFastLane } from "@tmux-ide/daemon-client/terminal-fast-lane";
import type {
  MirrorSubscribeRequest,
  MirrorSubscription,
} from "../../../terminal/mirror/mirror-service.ts";
import { SessionRuntimeTerminalReplicaOwner } from "../../../terminal/session-runtime/terminal-replica-owner.ts";
import { TerminalFastLaneRendererAdapter } from "./terminal-fast-lane-renderer-adapter.ts";
import { registerPaneSurface, type PaneSurfaceRenderable } from "../pane-surface.tsx";
import {
  renderForTest,
  destroyTestRenderer,
  frameLines,
} from "../testing/renderer-harness.test.ts";
import { createSemanticThemeSnapshot, createTerminalPaletteProjection } from "../theme.ts";

const generation = "00000000-0000-4000-8000-000000000008";
const paneId = "pane.failure";
const encode = (text: string) => new TextEncoder().encode(text);

for (const seam of ["postprocess", "grapheme"] as const) {
  it(`recovers a one-shot ${seam} failure without another upstream publication`, async () => {
    registerPaneSurface();
    const root = mkdtempSync(join(tmpdir(), `tmux-draw-${seam}-`));
    const cleanup: Array<() => void | Promise<void>> = [];
    const cleanupErrors: string[] = [];
    const faults: string[] = [];
    const renderErrors: string[] = [];
    const frames: unknown[] = [];
    let request!: MirrorSubscribeRequest;
    let surface!: PaneSurfaceRenderable;
    let closed = false,
      destroyed = false,
      injected = 0,
      latestRevision = -1;
    let failure: string | undefined;
    let injectionFrameCount = -1,
      errorFrameCount = -1;
    const mirror = {
      subscribe: async (candidate: MirrorSubscribeRequest): Promise<MirrorSubscription> => {
        request = candidate;
        queueMicrotask(() => {
          candidate.onLayout?.({
            type: "layout",
            session: "draw-failure",
            semanticWindowId: "window.failure",
            windowName: "failure",
            currentWindow: true,
            cols: 12,
            rows: 4,
            zoomed: false,
            paneBorderStatus: "off",
            panes: [
              { semanticPaneId: paneId, left: 0, top: 0, width: 12, height: 4, active: true },
            ],
          });
          candidate.onEvent({ type: "reset", cols: 12, rows: 4 });
          candidate.onEvent({ type: "seed", data: encode("\x1b[2J\x1b[HOLD\x1b[2;1Hbase") });
          candidate.onEvent({ type: "cursor", x: 1, y: 1 });
        });
        return {
          session: candidate.session,
          semanticPaneId: paneId,
          freeze() {},
          thaw() {},
          reseed() {},
          sendText() {},
          sendKey() {},
          close: async () => {
            closed = true;
          },
        };
      },
    };
    try {
      const owner = new SessionRuntimeTerminalReplicaOwner(
        generation,
        "draw-failure",
        paneId,
        mirror as never,
        {
          incarnation: "draw:0",
          initialRevision: 0,
          onFault: (error) => faults.push(String(error)),
        },
      );
      cleanup.push(() => owner.dispose());
      let deliver: ((update: CanonicalTerminalReplicaUpdate) => void) | undefined;
      const lane = createTerminalFastLane({
        address: { workspaceName: "draw-failure", generation },
        source: {
          subscribe: (_address, listener) => {
            deliver = listener;
            return () => {
              deliver = undefined;
            };
          },
        },
        repair: {
          request: () => {
            faults.push("unexpected repair");
          },
        },
        control: {
          owns: () => true,
          request: async () => true,
          write: async () => "ok",
          resize: async () => "ok",
        },
      });
      cleanup.push(() => lane.dispose());
      const adapter = new TerminalFastLaneRendererAdapter(lane);
      cleanup.push(() => adapter.dispose());
      const [version, setVersion] = createSignal(0);
      cleanup.push(adapter.subscribePaneVersion(paneId, () => setVersion((v) => v + 1)));
      const canonical = await owner.subscribe((update) => {
        latestRevision = update.revision;
        deliver?.(update);
      });
      cleanup.push(() => canonical.close());
      const palette = createTerminalPaletteProjection(
        createSemanticThemeSnapshot({ mode: "dark" }),
      );
      const setup = await renderForTest(
        () => (
          <pane_surface
            ref={(value: PaneSurfaceRenderable) => {
              surface = value;
            }}
            width={12}
            height={4}
            mirror={adapter.renderSource}
            paneId={paneId}
            paneFocused={true}
            contentVersion={version()}
            defaultFg={0xffffff}
            defaultBg={0}
            terminalPalette={palette}
            searchHl={palette.searchHighlight}
            searchCur={palette.searchCurrent}
          />
        ),
        { width: 12, height: 4, consoleMode: "disabled" },
      );
      cleanup.push(() => {
        destroyTestRenderer(setup);
        destroyed = setup.renderer.isDestroyed;
      });
      const capture = () => ({
        lines: frameLines(setup.captureCharFrame()),
        cursor: setup.renderer.getCursorState(),
      });
      const onFrame = () => {
        frames.push(capture());
      };
      const onError = (event: { error: Error }) => {
        renderErrors.push(event.error.message);
        errorFrameCount = frames.length;
      };
      setup.renderer.on(CliRenderEvents.FRAME, onFrame);
      setup.renderer.on(CliRenderEvents.RENDER_ERROR, onError);
      cleanup.push(() => {
        setup.renderer.off(CliRenderEvents.FRAME, onFrame);
        setup.renderer.off(CliRenderEvents.RENDER_ERROR, onError);
      });
      await setup.renderOnce();
      expect(capture().lines).toEqual([
        "OLD         ",
        "base        ",
        "            ",
        "            ",
      ]);
      expect(capture().cursor).toMatchObject({ x: 2, y: 2, visible: true });
      let armed = true;
      if (seam === "postprocess") {
        const interrupt = () => {
          if (armed) {
            armed = false;
            injected++;
            injectionFrameCount = frames.length;
            throw Error("owned postprocess interruption");
          }
        };
        setup.renderer.addPostProcessFn(interrupt);
        cleanup.push(() => setup.renderer.removePostProcessFn(interrupt));
      } else {
        const fb = surface.frameBuffer;
        const original = fb.drawText;
        fb.drawText = function (...args: Parameters<typeof original>) {
          if (armed && args[0] === "e\u0301") {
            armed = false;
            injected++;
            injectionFrameCount = frames.length;
            throw Error("owned grapheme interruption");
          }
          return original.apply(this, args);
        };
        cleanup.push(() => {
          fb.drawText = original;
        });
      }

      const prior = latestRevision;
      request.onEvent({ type: "delta", data: encode("\x1b[He\u0301NEW\x1b[2;1Hdone\x1b[3;5H") });
      const deadline = Date.now() + 1000;
      while (latestRevision <= prior && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 1));
      expect(latestRevision).toBeGreaterThan(prior);
      const revision = latestRevision;
      await setup.renderOnce();
      expect(injected).toBe(1);
      expect(renderErrors).toEqual([`owned ${seam} interruption`]);
      expect(errorFrameCount).toBe(injectionFrameCount);
      const beforeRetry = frames.length;
      await setup.renderOnce();
      expect(frames.length).toBeGreaterThan(beforeRetry);
      expect(latestRevision).toBe(revision);
      expect(injected).toBe(1);
      const recovered = capture();
      expect(recovered.lines).toEqual([
        "e\u0301NEW        ",
        "done        ",
        "            ",
        "            ",
      ]);
      expect(recovered.cursor).toMatchObject({ x: 5, y: 3, visible: true });
      request.onEvent({ type: "delta", data: encode("\x1b[2;1Hnext\x1b[4;2H") });
      const nextDeadline = Date.now() + 1000;
      while (latestRevision <= revision && Date.now() < nextDeadline)
        await new Promise((resolve) => setTimeout(resolve, 1));
      expect(latestRevision).toBeGreaterThan(revision);
      await setup.renderOnce();
      expect(capture().lines).toEqual([
        "e\u0301NEW        ",
        "next        ",
        "            ",
        "            ",
      ]);
      expect(capture().cursor).toMatchObject({ x: 2, y: 4, visible: true });
      expect(injected).toBe(1);
      expect(faults).toEqual([]);
    } catch (error) {
      failure = String(error);
      throw error;
    } finally {
      for (const dispose of cleanup.reverse()) {
        try {
          await dispose();
        } catch (error) {
          cleanupErrors.push(String(error));
        }
      }
      writeFileSync(
        join(root, "receipt.json"),
        JSON.stringify(
          {
            seam,
            bun: Bun.version,
            sourceSha256: createHash("sha256")
              .update(readFileSync(fileURLToPath(import.meta.url)))
              .digest("hex"),
            productionSourceHashes: Object.fromEntries(
              ["../pane-surface.tsx", "./terminal-fast-lane-renderer-adapter.ts"].map((path) => [
                path,
                createHash("sha256")
                  .update(readFileSync(fileURLToPath(new URL(path, import.meta.url))))
                  .digest("hex"),
              ]),
            ),
            injected,
            injectionFrameCount,
            errorFrameCount,
            latestRevision,
            frames,
            renderErrors,
            faults,
            failure,
            cleanup: { closed, destroyed, errors: cleanupErrors },
            scope:
              "Controlled public mirror events through real owner/lane/adapter/surface/native test renderer; one-shot injected exception, no physical emulator or ordinary production failure claim.",
          },
          null,
          2,
        ),
      );
      console.log(`Draw failure receipt: ${join(root, "receipt.json")}`);
      expect(cleanupErrors).toEqual([]);
      expect(closed).toBe(true);
      expect(destroyed).toBe(true);
    }
  }, 10000);
}
