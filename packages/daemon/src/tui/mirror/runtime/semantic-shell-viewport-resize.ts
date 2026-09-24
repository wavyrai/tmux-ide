import type { ApplicationShellProjectionV1 } from "@tmux-ide/contracts";

import type { OpenTuiGenerationHostSnapshot } from "./open-tui-generation-host.ts";
import { applicationShellViewport } from "./application-shell-viewport.ts";

import type { OpenTuiWorkspaceLayout } from "../open-tui-workspace-runtime-port.ts";

type Dimensions = Readonly<{ width: number; height: number }>;

/**
 * Owns the one semantic-shell viewport resize for the current generation.
 * Provisional local chrome is intentionally not terminal geometry authority.
 */
export function createSemanticShellViewportResizeOwner(
  getLayout: () => {
    readonly windows?: readonly Pick<
      OpenTuiWorkspaceLayout,
      "semanticWindowId" | "paneBorderStatus"
    >[];
    readonly current: Pick<OpenTuiWorkspaceLayout, "paneBorderStatus"> | null;
  } = () => ({ current: { paneBorderStatus: "top" } }),
  sidebarVisible: () => boolean = () => true,
): Readonly<{
  adopt(
    dimensions: Dimensions,
    semantic: ApplicationShellProjectionV1 | null,
    generation: OpenTuiGenerationHostSnapshot | null,
    paneBorderStatus?: "off" | "top" | "bottom",
  ): void;
  dispose(): void;
}> {
  let disposed = false;
  type ResizeIdentity = Readonly<{
    lane: NonNullable<OpenTuiGenerationHostSnapshot["fastLane"]>;
    daemonGeneration: string;
    rendererEpoch: number;
    cols: number;
    rows: number;
  }>;
  let applied: ResizeIdentity | null = null;
  let pending: ResizeIdentity | null = null;
  type ScopedTarget = Readonly<{ cols: number; rows: number; semanticWindowId?: string }>;
  let desired: Readonly<{ identity: ResizeIdentity; targets: readonly ScopedTarget[] }> | null =
    null;
  let scopedFlight: object | null = null;
  let scopedEpoch = 0;
  let authorityClient: OpenTuiGenerationHostSnapshot["authorityClient"] = null;
  let stopAuthority: (() => void) | null = null;
  let geometryOwner: string | null = null;
  let authoritySuspended = false;
  let retry: (() => void) | null = null;
  const scopedApplied = new Map<string, string>();
  const targetKey = (target: ScopedTarget) => target.semanticWindowId ?? "";
  const targetSize = (target: ScopedTarget) => `${target.cols}x${target.rows}`;
  const drain = async (): Promise<void> => {
    if (scopedFlight || disposed || authoritySuspended) return;
    const flight = {};
    scopedFlight = flight;
    try {
      while (desired && !disposed && !authoritySuspended) {
        const owner = desired;
        const epoch = scopedEpoch;
        const target = owner.targets.find(
          (entry) => scopedApplied.get(targetKey(entry)) !== targetSize(entry),
        );
        if (!target) break;
        // A global fit clears this control client's window overrides. Forget
        // them before dispatch, including a reversal while the receipt waits.
        if (target.semanticWindowId === undefined) scopedApplied.clear();
        else scopedApplied.delete(targetKey(target));
        const outcome = await owner.identity.lane.lane
          .resize(target)
          .catch(() => ({ status: "failed" as const }));
        if (disposed || !desired) break;
        if (epoch !== scopedEpoch) break;
        const stillDesired = desired.targets.some(
          (entry) =>
            targetKey(entry) === targetKey(target) && targetSize(entry) === targetSize(target),
        );
        if (outcome.status !== "applied") {
          if (!stillDesired) continue;
          break;
        }
        // Preserve the actual accepted size even after a reversal so the next
        // pass compares current truth with the latest complete desired set.
        if (desired.targets.some((entry) => targetKey(entry) === targetKey(target)))
          scopedApplied.set(targetKey(target), targetSize(target));
      }
    } finally {
      if (scopedFlight === flight) scopedFlight = null;
    }
  };
  const sameAuthority = (left: ResizeIdentity, right: ResizeIdentity): boolean =>
    left.lane === right.lane &&
    left.daemonGeneration === right.daemonGeneration &&
    left.rendererEpoch === right.rendererEpoch;
  const same = (left: ResizeIdentity | null, right: ResizeIdentity): boolean =>
    left?.lane === right.lane &&
    left.daemonGeneration === right.daemonGeneration &&
    left.rendererEpoch === right.rendererEpoch &&
    left.cols === right.cols &&
    left.rows === right.rows;

  return Object.freeze({
    adopt: function adopt(
      dimensions,
      semantic,
      generation,
      paneBorderStatus = getLayout().current?.paneBorderStatus ?? "off",
    ) {
      if (disposed) return;
      retry = () => adopt(dimensions, semantic, generation, paneBorderStatus);
      if (
        semantic === null ||
        generation?.status !== "live" ||
        generation.daemonGeneration === null ||
        generation.fastLane === null
      ) {
        stopAuthority?.();
        stopAuthority = null;
        authorityClient = null;
        authoritySuspended = false;
        applied = null;
        pending = null;
        desired = null;
        scopedEpoch += 1;
        scopedFlight = null;
        scopedApplied.clear();
        return;
      }
      if (authorityClient !== generation.authorityClient) {
        stopAuthority?.();
        authorityClient = generation.authorityClient;
        const observed = authorityClient;
        geometryOwner = observed?.getAuthoritySnapshot()?.owners.geometry ?? null;
        authoritySuspended =
          geometryOwner !== null && geometryOwner !== observed?.authorityIdentity.clientId;
        stopAuthority =
          observed?.onAuthority((snapshot) => {
            if (
              disposed ||
              authorityClient !== observed ||
              snapshot.generation !== generation.daemonGeneration
            )
              return;
            const next = snapshot.owners.geometry;
            if (next === geometryOwner) return;
            geometryOwner = next;
            authoritySuspended = next !== null && next !== observed.authorityIdentity.clientId;
            // The daemon clears scoped fits on handoff even when the host/runtime
            // identity survives. Reacquisition must rebuild them from current truth.
            applied = null;
            pending = null;
            scopedApplied.clear();
            scopedEpoch += 1;
            scopedFlight = null;
            if (!authoritySuspended) retry?.();
          }) ?? null;
      }
      const viewport = applicationShellViewport(dimensions, true, sidebarVisible());
      const lane = generation.fastLane;
      const target = Object.freeze({
        lane,
        daemonGeneration: generation.daemonGeneration,
        rendererEpoch: generation.rendererEpoch,
        cols: viewport.width,
        rows: Math.max(2, viewport.height - (paneBorderStatus === "off" ? 1 : 0)),
      });
      const windows = getLayout().windows;
      if (
        windows &&
        windows.every(
          (window) =>
            typeof window.semanticWindowId === "string" && window.semanticWindowId.length > 0,
        )
      ) {
        applied = null;
        pending = null;
        if (!desired || !sameAuthority(desired.identity, target)) {
          scopedEpoch += 1;
          // A retired lane must not hold a replacement lane behind its receipt.
          scopedFlight = null;
          scopedApplied.clear();
        }
        const retainedWindows = new Set(["", ...windows.map((window) => window.semanticWindowId!)]);
        for (const key of scopedApplied.keys())
          if (!retainedWindows.has(key)) scopedApplied.delete(key);
        desired = {
          identity: target,
          targets: [
            // Unscoped/new windows inherit a stable size, independent of the
            // selected window's border policy. Known windows then fit their own
            // header reservation without resizing their neighbours on switch.
            { cols: viewport.width, rows: Math.max(2, viewport.height - 1) },
            ...windows.map((window) => ({
              semanticWindowId: window.semanticWindowId!,
              cols: viewport.width,
              rows: Math.max(2, viewport.height - (window.paneBorderStatus === "off" ? 1 : 0)),
            })),
          ],
        };
        void drain();
        return;
      }
      if (desired) {
        desired = null;
        scopedEpoch += 1;
        scopedFlight = null;
        scopedApplied.clear();
        applied = null;
        pending = null;
      }
      if (authoritySuspended || same(applied, target) || same(pending, target)) return;
      // The accepted size stops being a dedupe target as soon as another
      // resize can mutate tmux. Otherwise A -> B -> A drops the final A while
      // B is still awaiting its receipt. The fast lane owns first/latest
      // coalescing; it must see the reversal to retain the actual final size.
      applied = null;
      pending = target;
      void lane.lane.resize({ cols: target.cols, rows: target.rows }).then(
        (outcome) => {
          if (disposed || pending !== target) return;
          pending = null;
          if (outcome.status === "applied") applied = target;
        },
        () => {
          if (pending === target) pending = null;
        },
      );
    },
    dispose() {
      disposed = true;
      retry = null;
      stopAuthority?.();
      stopAuthority = null;
      authorityClient = null;
      desired = null;
      scopedFlight = null;
      scopedApplied.clear();
      applied = null;
      pending = null;
    },
  });
}
