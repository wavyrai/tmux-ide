import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ResizeTransactionController } from "../../../packages/core/src/resize-transaction.ts";
import type { PaneStreamRuntimeClient } from "../../../packages/daemon-client/src/pane-stream-client.ts";
import { resizePane, type ResizeTarget, type PaneResizeReceipt } from "./pane-resize.ts";
import type { Layout } from "./topology.ts";

const identity = {
  type: z.literal("resize-gesture"),
  request: z.number().int().positive().safe(),
  gesture: z.string().uuid(),
  id: z.string().min(1).max(512),
  axis: z.enum(["cols", "rows"]),
};
const cells = z.number().int().min(2).max(1000);
export const resizeGestureSchema = z
  .discriminatedUnion("phase", [
    z.object({ ...identity, phase: z.literal("begin"), token: z.string().uuid(), cells }).strict(),
    z.object({ ...identity, phase: z.literal("move"), cells }).strict(),
    z.object({ ...identity, phase: z.literal("release"), cells }).strict(),
    z.object({ ...identity, phase: z.literal("cancel") }).strict(),
  ])
  .refine((v) => !("cells" in v) || v.axis !== "rows" || v.cells <= 500);
export type ResizeGesture = z.infer<typeof resizeGestureSchema>;
export const resizeGesturePublicationSchema = z
  .object({
    gesture: z.string().uuid(),
    id: z.string().min(1).max(512),
    axis: z.enum(["cols", "rows"]),
    phase: z.enum(["dragging", "pending", "settled", "failed", "cancelled"]),
    revision: z.number().int().nonnegative().safe(),
    token: z.string().uuid().nullable(),
    cells: z.number().int().positive().max(1000),
  })
  .strict();
export type ResizeGesturePublication = z.infer<typeof resizeGesturePublicationSchema>;
export type GestureTarget = ResizeTarget & {
  /** Changes when any subscribed pane lifetime changes, independently of geometry. */
  presentationEpoch: number;
  layout: Layout;
  cells: number;
  geometryOwned: boolean;
  coherent: boolean;
};
/** Geometry on the manipulated axis may converge; other-axis geometry and membership may not. */
function invariant(target: GestureTarget, axis: "cols" | "rows") {
  return JSON.stringify([
    target.generation,
    target.workspace,
    target.window,
    target.lifetime,
    target.presentationEpoch,
    target.statusRows,
    target.layout.cols,
    target.layout.rows,
    target.layout.zoomed,
    target.layout.panes
      .map((p) => [p.pane, ...(axis === "cols" ? [p.top, p.height] : [p.left, p.width])])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ]);
}
/** Only the captured divider group may move; other splits are not attributed to this gesture. */
function sameSplit(before: GestureTarget, after: GestureTarget, id: string, axis: "cols" | "rows") {
  const start = (p: Layout["panes"][number]) => (axis === "cols" ? p.left : p.top);
  const extent = (p: Layout["panes"][number]) => (axis === "cols" ? p.width : p.height);
  const pane = before.layout.panes.find((p) => p.pane === id);
  const current = after.layout.panes.find((p) => p.pane === id);
  if (!pane || !current || start(pane) !== start(current)) return false;
  const boundary = start(pane) + extent(pane);
  const nextBoundary = start(current) + extent(current);
  return before.layout.panes.every((old) => {
    const next = after.layout.panes.find((p) => p.pane === old.pane)!;
    if (!next) return false;
    const end = start(old) + extent(old);
    if (start(old) === start(pane) && end === boundary)
      return start(next) === start(old) && start(next) + extent(next) === nextBoundary;
    if (start(old) === boundary + 1)
      return start(next) === nextBoundary + 1 && start(next) + extent(next) === end;
    return start(next) === start(old) && extent(next) === extent(old);
  });
}
export function createResizeGestureOwner(options: {
  runtime: () => PaneStreamRuntimeClient | null;
  current: (id: string, axis: "cols" | "rows") => GestureTarget | null;
  changed: () => void;
}) {
  let active: Extract<ResizeGesture, { phase: "begin" }> | null = null;
  let initial: GestureTarget | null = null;
  let receipt: PaneResizeReceipt | null = null;
  let publication: ResizeGesturePublication | null = null;
  let revision = 0,
    busy = false,
    cancelled = false,
    failed = false,
    acquired = false;
  let acceptedToken: string | null = null;
  let publishedGesture: string | null = null;
  const emit = (phase: ResizeGesturePublication["phase"], token: string | null, actual: number) => {
    if (!active || publishedGesture !== active.gesture) return;
    if (revision === Number.MAX_SAFE_INTEGER) throw Error("Resize revision exhausted");
    publication = {
      gesture: active.gesture,
      id: active.id,
      axis: active.axis,
      phase,
      revision: ++revision,
      token,
      cells: actual,
    };
    options.changed();
  };
  const valid = () => {
    if (!active || !initial) return null;
    const now = options.current(active.id, active.axis);
    return now &&
      invariant(now, active.axis) === invariant(initial, active.axis) &&
      sameSplit(initial, now, active.id, active.axis)
      ? now
      : null;
  };
  const fail = () => {
    if (!active || failed) return;
    failed = true;
    controller.retire();
    receipt = null;
    emit("failed", null, initial!.cells);
  };
  const controller = new ResizeTransactionController({
    timeoutMs: 5000,
    operationId: randomUUID,
    now: () => performance.now(),
    schedule: (callback, ms) => {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    },
    onState: (state) => {
      if (!active || failed) return;
      if (state.phase === "idle") {
        if (state.outcome?.kind === "reverted") {
          fail();
          return;
        }
        if (state.outcome?.kind === "settled")
          emit(
            cancelled ? "cancelled" : "settled",
            cancelled ? null : acceptedToken,
            state.canonicalCells! + initial!.statusRows * (active.axis === "rows" ? 1 : 0),
          );
      } else
        emit(
          cancelled ? "cancelled" : state.phase,
          state.phase === "pending" || cancelled ? null : acceptedToken,
          state.canonicalCells + initial!.statusRows * (active.axis === "rows" ? 1 : 0),
        );
    },
    submit: (submission) => {
      const target = valid();
      const runtime = options.runtime();
      if (!target || !runtime || busy || !active || failed) throw Error("Resize target retired");
      receipt = null;
      busy = true;
      const gesture = active.gesture;
      const command = {
        type: "resize-pane" as const,
        request: active.request,
        id: active.id,
        token: target.token,
        axis: active.axis,
        cells: submission.intent.cells + (active.axis === "rows" ? target.statusRows : 0),
      };
      void resizePane(runtime, () => valid(), command, submission.operationId)
        .then((result) => {
          busy = false;
          if (active?.gesture !== gesture || failed) return;
          if (!result) {
            fail();
            return;
          }
          receipt = result;
          observe();
        })
        .catch(() => {
          busy = false;
          if (active?.gesture === gesture) fail();
        });
    },
  });
  function observe() {
    if (!active || failed) return;
    const now = valid();
    if (!now) {
      fail();
      return;
    }
    if (now.geometryOwned) acquired = true;
    else if (acquired) {
      fail();
      return;
    }
    const state = controller.state();
    if (state.phase === "pending") {
      if (
        receipt &&
        receipt.operationId === state.operationId &&
        now.geometryOwned &&
        now.coherent &&
        now.cells === receipt.cells + (active.axis === "rows" ? now.statusRows : 0)
      ) {
        const settled = receipt;
        receipt = null;
        acceptedToken = now.token;
        controller.observeLayout({
          operationId: settled.operationId,
          authorityGeneration: now.generation,
          workspaceName: now.workspace,
          semanticPaneId: active.id,
          axis: active.axis,
          cells: settled.cells,
        });
      }
    } else if (state.phase === "dragging" && now.token !== acceptedToken) fail();
  }
  return {
    publication: () => publication,
    active: () => !!active && !failed && controller.state().phase !== "idle",
    observe,
    retire: () => {
      if (active && !failed) {
        cancelled = true;
        controller.retire();
        emit("cancelled", null, initial!.cells);
      }
    },
    command(raw: ResizeGesture) {
      const command = resizeGestureSchema.parse(raw);
      if (command.phase === "begin") {
        if (busy || controller.state().phase !== "idle") {
          // Reject the new gesture explicitly, but keep the old operation owner intact.
          // Its delayed completion must not overwrite this newer refusal publication.
          publishedGesture = command.gesture;
          publication = {
            gesture: command.gesture,
            id: command.id,
            axis: command.axis,
            phase: "failed",
            revision: ++revision,
            token: null,
            cells: command.cells,
          };
          options.changed();
          return;
        }
        const now = options.current(command.id, command.axis);
        if (!now || !now.coherent || now.token !== command.token || now.cells !== command.cells)
          return;
        publishedGesture = command.gesture;
        active = command;
        initial = now;
        failed = false;
        cancelled = false;
        acquired = now.geometryOwned;
        acceptedToken = now.token;
        receipt = null;
        controller.begin({
          authorityGeneration: now.generation,
          workspaceName: now.workspace,
          semanticPaneId: command.id,
          axis: command.axis,
          canonicalCells: now.cells - (command.axis === "rows" ? now.statusRows : 0),
        });
        return;
      }
      if (
        !active ||
        failed ||
        command.gesture !== active.gesture ||
        command.request !== active.request ||
        command.id !== active.id ||
        command.axis !== active.axis
      )
        return;
      if (command.phase === "cancel") {
        cancelled = true;
        controller.cancelDrag();
        emit("cancelled", null, initial!.cells);
        return;
      }
      if (cancelled) return;
      observe();
      if (failed) return;
      controller.move(command.cells - (command.axis === "rows" ? initial!.statusRows : 0));
      if (command.phase === "release") {
        controller.release();
        if (controller.state().phase === "idle")
          emit("settled", acceptedToken, valid()?.cells ?? initial!.cells);
      }
    },
  };
}
