import { fencedInputSchema, inputTargetMatches, createInputTargetGuard } from "./input-targets.ts";
import { z } from "zod";
import { agentLaunchGuidance, GENERIC_PANE_ACTION_ERROR } from "./agent-launch-guidance.ts";
import { resizeSchema, resizeWindow } from "./geometry.ts";
import { scrollSchema } from "./history.ts";
import { deliverInput, deliverPreviewInput, isPipelineInput } from "./input.ts";
import { kittyMissingSchema } from "./kitty-graphics.ts";
import { mouseSchema } from "./mouse.ts";
import { paneActionSchema } from "./pane-actions.ts";
import { paneResizeSchema, resizePane } from "./pane-resize.ts";
import { applyPresence, presenceSchema } from "./presence.ts";
import { resizeGestureSchema } from "./resize-gesture.ts";
import { splitGestureSchema } from "./split-gesture.ts";
import { routeWheel, wheelSchema } from "./wheel.ts";
import { contentRect } from "./window-canvas.ts";

import type { HostedLiveCommandContext } from "./hosted-live-command-context.ts";
export async function runHostedLiveCommands(c: HostedLiveCommandContext) {
  inputLoop: for await (let value of c.commands) {
    if (c.stopped) break;
    const fenced = fencedInputSchema.safeParse(value);
    if (fenced.success) value = fenced.data.input;
    const validTarget = createInputTargetGuard(
      () =>
        !fenced.success ||
        inputTargetMatches(fenced.data.id, fenced.data.inputTarget, c.selected, (id) =>
          c.currentInputTarget(id),
        ),
      () => {
        c.rejectInputTarget();
        c.stop();
      },
    );
    if (!validTarget()) continue;
    const pipelined = isPipelineInput(value);
    // Other commands are barriers, including presence, history, paste and control keys.
    if (!pipelined) await c.inputPipeline.barrier();
    if (c.stopped) break;
    const handoff = z
      .object({ kind: z.literal("history-handoff"), intent: z.uuid() })
      .strict()
      .safeParse(value);
    if (handoff.success) {
      // Ordered after accepted history navigation; no later command may act.
      c.foreground = false;
      c.closePaneReady = null;
      c.actionFence.invalidate();
      c.mouseOwner.retire();
      c.splitGesture.retire();
      c.resizeGesture.retire();
      await applyPresence(c.runtime, false);
      const captured = await c.historyRestoration?.settleCapture();
      c.publish();
      if (!c.stopped)
        c.emit({
          kind: "history-handoff",
          intent: handoff.data.intent,
          ...(captured ?? { state: "unavailable", token: null }),
        });
      c.stop();
      break inputLoop;
    }
    const missing = kittyMissingSchema.safeParse(value);
    if (missing.success) {
      c.kitty.missing(missing.data.digests);
      if (c.latest.snapshot) c.output(c.latest.snapshot);
      continue;
    }
    const presence = presenceSchema.safeParse(value);
    if (presence.success) {
      c.admittedPresenceRevision = presence.data.revision;
      c.closePaneReady = null;
      c.actionFence.invalidate();
      c.mouseOwner.retire();
      c.foreground = presence.data.active;
      if (!c.foreground) c.splitGesture.retire();
      if (!c.foreground && c.latest.snapshot) c.output(c.latest.snapshot);
      await applyPresence(c.runtime, c.foreground);
      c.presenceRevision = presence.data.revision;
      if (c.foreground) c.resizeBlocked = false;
      if (c.latest.snapshot) c.output(c.latest.snapshot);
      continue;
    }
    const reselect = c.selectPaneSchema.safeParse(value);
    if (reselect.success) {
      const id = reselect.data.id;
      if (id === c.selected) {
        c.output(c.latest.snapshot);
        continue;
      }
      const frame = c.replicas.get(id)?.current();
      const layout = c.layouts.find((l) => l.semanticWindowId === c.semanticWindow);
      if (
        !frame ||
        !c.visiblePaneIds.includes(id) ||
        !c.surfaces.has(id) ||
        !c.lifetimes.get(id) ||
        !layout?.panes.some((pane) => pane.pane === id) ||
        c.viewport.offset !== 0 ||
        c.restorePending ||
        c.historyRestoration.publication().state === "restoring" ||
        c.actionBusy
      ) {
        // Never leave later input addressed to the previous pane; the browser
        // replaces a refusing helper with a fresh attachment for the target.
        c.stop();
        break inputLoop;
      }
      c.closePaneReady = null;
      c.actionFailed = false;
      c.actionFence.invalidate();
      c.mouseOwner.retire();
      c.splitGesture.retire();
      c.resizeGesture.retire();
      c.selected = id;
      c.selectedActionPane = id;
      c.viewport.update(null);
      c.surfaces.set(id, c.viewport.update(frame.snapshot)!);
      c.historyRestoration.observe(null);
      c.historyRestoration.observe(frame);
      if (c.historyRestoration.publication().state !== "live") c.historyRestoration.live();
      // Rotate resize/mouse/action identities: nothing granted for the old pane carries over.
      if (c.presentationEpoch === Number.MAX_SAFE_INTEGER)
        throw new Error("Presentation lifetime limit exceeded");
      c.presentationEpoch++;
      c.output(c.surfaces.get(c.selected) ?? null);
      continue;
    }
    if (c.restorePending || c.historyRestoration?.publication().state === "restoring") {
      const returnLive = scrollSchema.safeParse(value);
      if (!returnLive.success || returnLive.data.data !== 0) continue;
    }
    const splitCommand = splitGestureSchema.safeParse(value);
    if (splitCommand.success) {
      if (c.foreground || splitCommand.data.phase === "cancel") {
        c.resizeGesture.retire();
        if (splitCommand.data.phase === "begin" && !c.runtime.ownsConnectionAuthority("geometry"))
          await c.runtime.requestAuthority("geometry");
        if (c.foreground || splitCommand.data.phase === "cancel")
          c.splitGesture.command(splitCommand.data);
      }
      continue;
    }
    const gesture = resizeGestureSchema.safeParse(value);
    if (gesture.success) {
      if (c.foreground || gesture.data.phase === "cancel") {
        c.splitGesture.retire();
        c.resizeGesture.command(gesture.data);
      }
      continue;
    }
    if (!c.foreground) continue;
    const paneAction = paneActionSchema.safeParse(value);
    if (paneAction.success) {
      if (c.actionBusy) continue;
      c.resizeGesture.retire();
      c.splitGesture.retire();
      const target = () => {
        const layout = c.layouts.find((l) => l.semanticWindowId === c.semanticWindow);
        const lifetime = c.lifetimes.get(c.selected);
        if (
          c.stopped ||
          !c.foreground ||
          c.viewport.offset !== 0 ||
          !c.latest.snapshot ||
          c.actionFailed ||
          paneAction.data.id !== c.selected ||
          !c.surfaces.has(c.selected) ||
          !layout?.semanticWindowId ||
          !lifetime
        )
          return null;
        const capability = c.actionFence.current(layout, c.selected, lifetime);
        return capability
          ? {
              token: capability.token,
              id: c.selected,
              generation: c.config.scope.generation,
              workspace: c.config.workspaceName,
              window: layout.semanticWindowId,
              lifetime,
            }
          : null;
      };
      if (target()?.token !== paneAction.data.token) continue;
      if (paneAction.data.action === "close") {
        const revision = c.admittedPresenceRevision;
        c.actionBusy = true;
        c.closePaneReady = null;
        c.output(c.latest.snapshot);
        void c
          .prepareClose(c.runtime, () => {
            const value = target();
            return value && c.admittedPresenceRevision === revision
              ? { ...value, session: c.config.liveSessionId, presenceRevision: revision }
              : null;
          })
          .then((result) => {
            c.actionFailed = !result;
            if (result)
              c.closePaneReady = {
                token: result.token,
                id: result.id,
                hostClientId: c.hostClientId,
                presenceRevision: revision,
              };
          })
          .catch(() => {
            c.actionFailed = true;
          })
          .finally(() => {
            c.actionBusy = false;
            if (!c.stopped) c.output(c.latest.snapshot);
          });
        continue;
      }
      if (paneAction.data.action === "new-window" || paneAction.data.action === "new-agent") {
        const revision = c.admittedPresenceRevision;
        c.actionBusy = true;
        c.newWindowReceipt = null;
        c.actionFailureMessage = GENERIC_PANE_ACTION_ERROR;
        c.output(c.latest.snapshot);
        void c
          .executeNewWindow(
            c.client,
            c.runtime,
            () => {
              const value = target();
              return value && c.admittedPresenceRevision === revision
                ? { ...value, session: c.config.liveSessionId, presenceRevision: revision }
                : null;
            },
            paneAction.data.action === "new-agent"
              ? { name: paneAction.data.name, harness: paneAction.data.harness }
              : undefined,
          )
          .then((result) => {
            c.actionFailed = !result;
            if (result) c.newWindowReceipt = { token: paneAction.data.token, result };
          })
          .catch((error: unknown) => {
            c.actionFailed = true;
            c.actionFailureMessage = agentLaunchGuidance(
              error,
              paneAction.data.action === "new-agent",
            );
          })
          .finally(() => {
            c.actionBusy = false;
            c.actionFence.invalidate();
            if (!c.stopped) c.output(c.latest.snapshot);
          });
        continue;
      }
      c.actionBusy = true;
      c.paneSplitReceipt = null;
      c.output(c.latest.snapshot);
      try {
        const result = await c.executePaneAction(c.runtime, target, paneAction.data);
        c.actionFailed = !result;
        if (typeof result === "object")
          c.paneSplitReceipt = { token: paneAction.data.token, result };
      } catch {
        c.actionFailed = true;
      } finally {
        c.actionBusy = false;
        c.actionFence.invalidate();
      }
      c.output(c.latest.snapshot);
      continue;
    }
    const paneResize = paneResizeSchema.safeParse(value);
    if (paneResize.success) {
      if (c.resizeGesture.active()) continue;
      const target = () => {
        const layout = c.layouts.find((l) => l.semanticWindowId === c.semanticWindow);
        const lifetime = c.lifetimes.get(paneResize.data.id);
        if (
          c.stopped ||
          !c.foreground ||
          c.viewport.offset !== 0 ||
          !c.latest.snapshot ||
          !c.visiblePaneIds.includes(paneResize.data.id) ||
          !c.surfaces.has(paneResize.data.id) ||
          !layout?.panes.some((p) => p.pane === paneResize.data.id) ||
          !lifetime ||
          !layout.semanticWindowId
        )
          return null;
        const pane = layout.panes.find((p) => p.pane === paneResize.data.id)!;
        const token = c.resizeFence(layout, c.presentationEpoch);
        return token
          ? {
              token,
              generation: c.config.scope.generation,
              workspace: c.config.workspaceName,
              window: layout.semanticWindowId,
              lifetime,
              statusRows: pane.height - contentRect(layout, pane).rows,
            }
          : null;
      };
      try {
        const receipt = await resizePane(c.runtime, target, paneResize.data);
        c.resizeBlocked = receipt === null;
      } catch {
        c.resizeBlocked = true;
      }
      c.output(c.latest.snapshot);
      continue;
    }
    const mouse = mouseSchema.safeParse(value);
    if (mouse.success) {
      if (
        !c.latest.snapshot ||
        c.viewport.offset > 0 ||
        !c.runtime.ownsConnectionAuthority("input")
      ) {
        c.mouseOwner.retire();
        continue;
      }
      const input = c.mouseOwner.route(c.latest.snapshot, c.mouseIdentity(), mouse.data);
      if (input) {
        try {
          await deliverInput(c.runtime, c.config.workspaceName, c.selected, input);
        } catch (error) {
          c.mouseOwner.retire();
          throw error;
        }
      }
      continue;
    }
    const wheel = wheelSchema.safeParse(value);
    if (wheel.success) {
      c.mouseOwner.retire();
      c.resizeGesture.retire();
      if (!c.latest.snapshot) continue;
      const route = routeWheel(c.latest.snapshot, c.viewport.offset, wheel.data);
      if (!route) continue;
      if (route.kind === "application") {
        for (const input of route.inputs) {
          await deliverInput(c.runtime, c.config.workspaceName, c.selected, input);
        }
      } else {
        const view = c.viewport.scroll(route.lines);
        if (view) c.surfaces.set(c.selected, view);
        c.historyRestoration?.capture(c.viewport.captureIndex());
        c.output(view);
      }
      continue;
    }
    const scroll = scrollSchema.safeParse(value);
    if (scroll.success) {
      c.mouseOwner.retire();
      c.resizeGesture.retire();
      const view = c.viewport.scroll(scroll.data.data);
      c.restorePending = false;
      if (view) c.surfaces.set(c.selected, view);
      c.historyRestoration?.capture(c.viewport.captureIndex());
      c.output(view);
      continue;
    }
    const resize = resizeSchema.safeParse(value);
    if (resize.success) {
      if (resize.data.data.cellWidth && resize.data.data.cellHeight) {
        c.cellPixels = {
          width: resize.data.data.cellWidth,
          height: resize.data.data.cellHeight,
          ...(resize.data.data.cellWidthMilli && resize.data.data.cellHeightMilli
            ? {
                precise: {
                  width: resize.data.data.cellWidthMilli,
                  height: resize.data.data.cellHeightMilli,
                },
              }
            : {}),
        };
        c.applyCellPixels();
      }
      c.mouseOwner.retire();
      c.resizeGesture.retire();
      if (!c.resizeBlocked && c.latest.snapshot) {
        try {
          c.resizeBlocked = !(await resizeWindow(c.runtime, () => c.semanticWindow, resize.data));
        } catch {
          c.resizeBlocked = true;
        }
        c.output(c.latest.snapshot);
      }
      continue;
    }
    if (
      c.restorePending ||
      c.historyRestoration?.publication().state === "restoring" ||
      c.viewport.offset > 0
    )
      continue; // Never type into a historical view.
    if (!c.latest.snapshot) throw new Error("No verified input target");
    const inputPane = c.selected;
    const inputLifetime = c.lifetimes.get(inputPane);
    const deliver = async () => {
      if (!validTarget()) return;
      // Recheck after waiting for capacity; a disconnect or authority loss can
      // arrive independently of stdin while earlier acknowledgements settle.
      if (
        c.stopped ||
        !c.foreground ||
        !c.latest.snapshot ||
        c.selected !== inputPane ||
        c.lifetimes.get(inputPane) !== inputLifetime ||
        c.restorePending ||
        c.historyRestoration?.publication().state === "restoring" ||
        c.viewport.offset > 0
      )
        throw new Error("Input target retired");
      await deliverPreviewInput(
        fenced.success
          ? {
              ownsConnectionAuthority: (kind) => c.inputRuntime.ownsConnectionAuthority(kind),
              sendTerminalInput: async (target, input) => {
                if (!validTarget()) return "ok";
                const proof = c.currentInputProof(inputPane);
                if (!proof) {
                  c.rejectInputTarget();
                  c.stop();
                  return "ok";
                }
                try {
                  const result = await c.inputRuntime.sendTerminalInput(
                    target,
                    input,
                    undefined,
                    undefined,
                    proof,
                  );
                  if (result !== "ok") {
                    c.rejectInputTarget();
                    c.stop();
                  }
                  return result;
                } catch (error) {
                  c.rejectInputTarget();
                  c.stop();
                  throw error;
                }
              },
            }
          : c.inputRuntime,
        c.config.workspaceName,
        inputPane,
        value,
        c.latest.snapshot.modes.bracketedPaste,
      );
    };
    if (pipelined) await c.inputPipeline.submit(deliver);
    else await deliver();
  }
}
