import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PaneStreamRuntimeClient } from "../../../packages/daemon-client/src/pane-stream-client.ts";
import {
  WindowSplitResizeTargetSchemaZ,
  type WindowSplitResizeTarget,
  type WindowSplitSuccessor,
} from "../../../packages/contracts/src/window-split-layout.ts";
import { resizeSplit, type SplitResizeSnapshot } from "./split-resize.ts";

const base = {
  type: z.literal("split-gesture"),
  request: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  gesture: z.uuid(),
};
const boundary = z.number().int().min(0).max(4096);
export const splitGestureSchema = z.discriminatedUnion("phase", [
  z
    .object({
      ...base,
      phase: z.literal("begin"),
      target: WindowSplitResizeTargetSchemaZ,
      axis: z.enum(["cols", "rows"]),
    })
    .strict(),
  z.object({ ...base, phase: z.enum(["move", "release"]), boundary }).strict(),
  z.object({ ...base, phase: z.literal("cancel") }).strict(),
]);
type Snapshot = SplitResizeSnapshot & { coherent: boolean; geometryOwned: boolean };
export const splitGesturePublicationSchema = z
  .object({
    gesture: z.uuid(),
    phase: z.enum(["dragging", "pending", "settled", "failed", "cancelled"]),
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    boundary,
    target: WindowSplitResizeTargetSchemaZ.nullable(),
  })
  .strict();
export type SplitGesturePublication = z.infer<typeof splitGesturePublicationSchema>;
type Active = {
  runtime: PaneStreamRuntimeClient;
  request: number;
  gesture: string;
  axis: "cols" | "rows";
  scope: SplitResizeSnapshot;
  target: WindowSplitResizeTarget;
  resource: NonNullable<Snapshot["resource"]>;
  desired: number;
  submitted: number;
  released: boolean;
  successor: WindowSplitSuccessor | null;
};
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sameWindow = (a: SplitResizeSnapshot["window"], b: SplitResizeSnapshot["window"]) =>
  a.liveSessionId === b.liveSessionId &&
  a.linkId === b.linkId &&
  a.expectedSemanticWindowId === b.expectedSemanticWindowId &&
  a.linkRevision === b.linkRevision;
const plain = ({
  generation,
  workspace,
  lifetime,
  window,
  resource,
}: Snapshot): SplitResizeSnapshot => ({ generation, workspace, lifetime, window, resource });

/** One in-flight mutation, one latest pointer target, and receipt-bound canonical rebasing. */
export function createSplitGestureOwner(options: {
  runtime: () => PaneStreamRuntimeClient | null;
  current: () => Snapshot | null;
  changed: () => void;
}) {
  let active: Active | null = null;
  let busy = false;
  let publication: SplitGesturePublication | null = null;
  let revision = 0;
  let visibleGesture: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const publish = (
    a: Active,
    phase: SplitGesturePublication["phase"],
    target: WindowSplitResizeTarget | null,
  ) => {
    if (visibleGesture !== a.gesture) return;
    if (
      publication?.gesture === a.gesture &&
      publication.phase === phase &&
      publication.boundary === (target?.boundary ?? a.target.boundary) &&
      equal(publication.target, target)
    )
      return;
    publication = {
      gesture: a.gesture,
      phase,
      revision: ++revision,
      boundary: target?.boundary ?? a.target.boundary,
      target: target ? structuredClone(target) : null,
    };
    options.changed();
  };
  const stop = (phase: "failed" | "cancelled") => {
    const a = active;
    if (!a) return;
    active = null;
    clear();
    publish(a, phase, null);
  };
  const wait = () => {
    clear();
    timer = setTimeout(() => stop("failed"), 5000);
    timer.unref();
  };
  const sameScope = (a: Active, now: Snapshot) =>
    now.generation === a.scope.generation &&
    now.workspace === a.scope.workspace &&
    now.lifetime === a.scope.lifetime &&
    sameWindow(now.window, a.scope.window);
  function observe() {
    const a = active;
    if (!a) return;
    const now = options.current();
    if (!now || !sameScope(a, now) || !now.geometryOwned || options.runtime() !== a.runtime) {
      stop("failed");
      return;
    }
    if (busy) return; // A pending mutation may temporarily withdraw the coherent resource.
    if (a.successor) {
      if (!now.coherent || !now.resource || !equal(now.resource, a.successor.resource)) return;
      a.resource = structuredClone(now.resource);
      a.target = {
        window: structuredClone(now.window),
        layoutId: now.resource.layoutId,
        splitId: a.successor.splitId,
        boundary: a.successor.resource.splits.find((s) => s.splitId === a.successor!.splitId)!
          .boundary,
      };
      a.successor = null;
      clear();
    } else if (!now.coherent || !equal(now.resource, a.resource)) {
      stop("failed");
      return;
    }
    if (a.desired !== a.submitted && a.desired !== a.target.boundary) {
      dispatch(a);
      return;
    }
    if (a.released) {
      active = null;
      clear();
      publish(a, "settled", a.target);
    } else publish(a, "dragging", a.target);
  }
  function dispatch(a: Active) {
    const runtime = options.runtime();
    if (!runtime || busy || active !== a) {
      stop("failed");
      return;
    }
    busy = true;
    a.submitted = a.desired;
    const target = { ...a.target, boundary: a.desired };
    wait();
    publish(a, "pending", null);
    void resizeSplit(
      runtime,
      () => {
        const now = options.current();
        return active === a && now && sameScope(a, now) && now.geometryOwned ? plain(now) : null;
      },
      { target, axis: a.axis },
      randomUUID(),
    )
      .then((result) => {
        busy = false;
        if (active !== a) return;
        if (!result?.successor) {
          stop("failed");
          return;
        }
        a.successor = structuredClone(result.successor);
        observe();
      })
      .catch(() => {
        busy = false;
        if (active === a) stop("failed");
      });
  }
  function command(raw: unknown): boolean {
    const parsed = splitGestureSchema.safeParse(raw);
    if (!parsed.success) return false;
    const input = parsed.data;
    if (input.phase === "begin") {
      const refuseBegin = () => {
        visibleGesture = input.gesture;
        publication = {
          gesture: input.gesture,
          phase: "failed",
          revision: ++revision,
          boundary: input.target.boundary,
          target: null,
        };
        options.changed();
        return false;
      };
      if (active || busy || publication?.gesture === input.gesture) return refuseBegin();
      const runtime = options.runtime();
      if (!runtime) return refuseBegin();
      const now = options.current();
      const split = now?.resource?.splits.find((s) => s.splitId === input.target.splitId);
      if (
        !now ||
        !now.coherent ||
        !now.geometryOwned ||
        !now.resource ||
        !sameWindow(now.window, input.target.window) ||
        !sameWindow(now.resource.window, now.window) ||
        now.resource.layoutId !== input.target.layoutId ||
        split?.axis !== input.axis ||
        split.boundary !== input.target.boundary
      )
        return refuseBegin();
      visibleGesture = input.gesture;
      active = {
        runtime,
        request: input.request,
        gesture: input.gesture,
        axis: input.axis,
        scope: structuredClone(plain(now)),
        resource: structuredClone(now.resource),
        target: input.target,
        desired: input.target.boundary,
        submitted: input.target.boundary,
        released: false,
        successor: null,
      };
      publish(active, "dragging", active.target);
      return true;
    }
    const a = active;
    if (!a || input.gesture !== a.gesture || input.request !== a.request) return false;
    if (input.phase === "cancel") {
      stop("cancelled");
      return true;
    }
    if (a.released) return false;
    a.desired = input.boundary;
    a.released = input.phase === "release";
    observe();
    return true;
  }
  return {
    command,
    observe,
    retire: () => stop("cancelled"),
    publication: () => (publication ? structuredClone(publication) : null),
  };
}
