import {
  AssetPaneMarkdownWidgetArgsSchemaZ,
  AssetPaneImageWidgetArgsSchemaZ,
  WidgetAssetMediaTypeSchemaZ,
  detectWidgetMarkerFromReplicaRows,
  type WidgetAssetId,
  type WidgetMarker,
} from "@tmux-ide/contracts";
import { hashTerminalWidgetContent } from "@tmux-ide/core";

import { resolveTuiWidgetSurface, type TuiWidgetSurface } from "../../widget-surface-model.ts";
import type { RichPlacementProjection } from "../../rich-placement-projection.ts";
import type {
  RichPreviewAsset,
  RichPreviewAuthorityToken,
  RichPreviewHost,
  RichPreviewRequest,
  RichPreviewResolution,
  RichPreviewSession,
  RichPreviewSessionMetrics,
} from "./contract.ts";

export const RICH_PREVIEW_RETAINED_BYTE_CAP = 16 * 1024 * 1024;

export interface RichPreviewSessionOptions {
  readonly retainedByteCap?: number;
}

export interface RichPreviewCanonicalSource {
  readonly workspaceId: string;
  readonly workspaceGeneration: string;
  readonly paneId: string;
  readonly paneGeneration: string;
  readonly snapshot: RichPreviewRequest["snapshot"];
}

/** Build exact authority tokens while retaining the canonical snapshot reference. */
export function richPreviewRequestsFromCanonical(
  source: RichPreviewCanonicalSource,
  placements: readonly RichPlacementProjection[],
): readonly RichPreviewRequest[] {
  return placements.map((projection) => ({
    authority: Object.freeze({
      workspaceId: source.workspaceId,
      workspaceGeneration: source.workspaceGeneration,
      paneId: source.paneId,
      paneGeneration: source.paneGeneration,
      renderableId: projection.renderableId,
      contentDigest: projection.placement.contentDigest,
    }),
    snapshot: source.snapshot,
    placement: projection.placement,
    visible: projection.visible,
  }));
}

interface PreviewSlot {
  readonly authorityKey: string;
  readonly request: RichPreviewRequest;
  readonly assetId: WidgetAssetId | null;
  readonly marker: WidgetMarker;
  resolution: RichPreviewResolution;
}

interface AssetJob {
  readonly assetId: WidgetAssetId;
  readonly controller: AbortController;
  readonly references: Set<PreviewSlot>;
  phase: "loading" | "ready" | "refused";
  asset: RichPreviewAsset | null;
  refusal: TuiWidgetSurface | null;
}

const loadingSurface = (title: string | null): TuiWidgetSurface => ({
  kind: "fallback",
  label: "Markdown",
  title,
  text: "Loading Markdown…",
});

const fallbackSurface = (label: string, title: string | null, text: string): TuiWidgetSurface => ({
  kind: "fallback",
  label,
  title,
  text,
});

function authorityKey(token: RichPreviewAuthorityToken): string {
  return JSON.stringify([
    token.workspaceId,
    token.workspaceGeneration,
    token.paneId,
    token.paneGeneration,
    token.renderableId,
    token.contentDigest,
  ]);
}

function recoverMarker(request: RichPreviewRequest): WidgetMarker | null {
  if (request.placement.contentDigest !== request.authority.contentDigest) return null;
  const snapshot = request.snapshot;
  // Traverse the two retained canonical row sets directly. Neither the row
  // list nor either cell grid is copied into optional-feature state.
  function* canonicalRows() {
    yield* snapshot.history;
    yield* snapshot.grid;
  }
  const marker = detectWidgetMarkerFromReplicaRows(canonicalRows());
  const verified =
    marker &&
    marker.id === request.placement.id &&
    hashTerminalWidgetContent(marker.id, marker.args) === request.authority.contentDigest
      ? marker
      : null;
  return verified;
}

function markerAssetId(marker: WidgetMarker): WidgetAssetId | null {
  if (marker.id === "markdown") {
    const parsed = AssetPaneMarkdownWidgetArgsSchemaZ.safeParse(marker.args);
    return parsed.success ? parsed.data.assetId : null;
  }
  if (marker.id === "image") {
    const parsed = AssetPaneImageWidgetArgsSchemaZ.safeParse(marker.args);
    return parsed.success ? parsed.data.assetId : null;
  }
  return null;
}

function resolveWithAsset(marker: WidgetMarker, asset: RichPreviewAsset | null): TuiWidgetSurface {
  return (
    resolveTuiWidgetSurface(marker, (assetId) =>
      asset?.assetId === assetId
        ? {
            version: 1,
            assetId: asset.assetId,
            media: asset.media,
            name: asset.name,
            byteLength: asset.byteLength,
            createdAt: new Date(0).toISOString(),
            bytes: Buffer.from(asset.bytes),
          }
        : null,
    ) ?? fallbackSurface(marker.id, null, "Rich preview content is unavailable.")
  );
}

/**
 * Demand owner for canonical rich previews.
 *
 * Every async result must still match all three authority tiers before it can
 * publish. Cache ownership follows visible renderable references; removing the
 * final reference aborts an in-flight read or evicts retained bytes immediately.
 */
export function createRichPreviewSession(
  host: RichPreviewHost,
  options: RichPreviewSessionOptions = {},
): RichPreviewSession {
  const cap = options.retainedByteCap ?? RICH_PREVIEW_RETAINED_BYTE_CAP;
  const slots = new Map<string, PreviewSlot>();
  const assets = new Map<WidgetAssetId, AssetJob>();
  let retainedBytes = 0;
  let disposed = false;
  let loadsStarted = 0;
  let joinedLoads = 0;
  let loadsAborted = 0;
  let lateResultsDiscarded = 0;
  let cacheLimitRefusals = 0;

  const notify = (): void => {
    if (!disposed) host.onChange();
  };

  const releaseAsset = (assetId: WidgetAssetId, slot: PreviewSlot): void => {
    const job = assets.get(assetId);
    if (!job) return;
    job.references.delete(slot);
    if (job.references.size > 0) return;
    if (job.phase === "loading") {
      loadsAborted += 1;
      job.controller.abort(new DOMException("Rich preview retired", "AbortError"));
    }
    if (job.asset) retainedBytes -= job.asset.bytes.byteLength;
    assets.delete(assetId);
  };

  const settle = (job: AssetJob, result: Awaited<ReturnType<RichPreviewHost["loadAsset"]>>) => {
    if (disposed || assets.get(job.assetId) !== job || job.references.size === 0) {
      lateResultsDiscarded += 1;
      return;
    }
    const validAsset =
      result.status === "ok" &&
      result.asset.assetId === job.assetId &&
      WidgetAssetMediaTypeSchemaZ.safeParse(result.asset.media).success &&
      result.asset.bytes.byteLength > 0 &&
      result.asset.byteLength === result.asset.bytes.byteLength;
    const actualBytes = result.status === "ok" ? result.asset.bytes.byteLength : 0;
    if (validAsset && retainedBytes + actualBytes <= cap) {
      job.phase = "ready";
      job.asset = result.asset;
      retainedBytes += actualBytes;
    } else {
      job.phase = "refused";
      const cacheLimit = validAsset && retainedBytes + actualBytes > cap;
      if (cacheLimit) cacheLimitRefusals += 1;
      job.refusal = fallbackSurface(
        "Markdown",
        null,
        result.status === "error" && result.reason === "aborted"
          ? "Markdown loading was cancelled."
          : cacheLimit
            ? "Markdown exceeds this terminal's rich-preview cache limit."
            : "Markdown asset is unavailable. Re-run the widget command to publish it again.",
      );
    }
    for (const slot of job.references) {
      if (slot.assetId !== job.assetId || slots.get(slot.request.authority.renderableId) !== slot)
        continue;
      slot.resolution =
        job.phase === "ready"
          ? {
              phase: "ready",
              surface: resolveWithAsset(slot.marker, job.asset),
              retainedBytes: job.asset?.bytes.byteLength ?? 0,
            }
          : {
              phase: "fallback",
              surface:
                job.refusal ?? fallbackSurface("Markdown", null, "Markdown asset is unavailable."),
              retainedBytes: 0,
            };
    }
    notify();
  };

  const retainAsset = (assetId: WidgetAssetId, slot: PreviewSlot): void => {
    let job = assets.get(assetId);
    if (job) {
      joinedLoads += 1;
      job.references.add(slot);
      if (job.phase !== "loading") {
        slot.resolution =
          job.phase === "ready"
            ? {
                phase: "ready",
                surface: resolveWithAsset(slot.marker, job.asset),
                retainedBytes: job.asset?.bytes.byteLength ?? 0,
              }
            : {
                phase: "fallback",
                surface:
                  job.refusal ??
                  fallbackSurface("Markdown", null, "Markdown asset is unavailable."),
                retainedBytes: 0,
              };
      }
      return;
    }
    const controller = new AbortController();
    job = {
      assetId,
      controller,
      references: new Set([slot]),
      phase: "loading",
      asset: null,
      refusal: null,
    };
    assets.set(assetId, job);
    loadsStarted += 1;
    void host.loadAsset(assetId, controller.signal).then(
      (result) => settle(job!, result),
      () =>
        settle(job!, {
          status: "error",
          reason: controller.signal.aborted ? "aborted" : "unavailable",
        }),
    );
  };

  const createSlot = (request: RichPreviewRequest): PreviewSlot | null => {
    const marker = recoverMarker(request);
    if (!marker) return null;

    // Capability honesty: generic terminals never touch the asset store for
    // raster/GIF content they cannot display.
    if (marker.id === "image" && host.capabilities?.rasterImages !== true) {
      return {
        authorityKey: authorityKey(request.authority),
        request,
        assetId: null,
        marker,
        resolution: {
          phase: "fallback",
          surface: resolveWithAsset(marker, null),
          retainedBytes: 0,
        },
      };
    }

    const assetId = markerAssetId(marker);
    if (!assetId) {
      return {
        authorityKey: authorityKey(request.authority),
        request,
        assetId: null,
        marker,
        resolution: { phase: "ready", surface: resolveWithAsset(marker, null), retainedBytes: 0 },
      };
    }
    const title =
      marker.id === "markdown"
        ? (AssetPaneMarkdownWidgetArgsSchemaZ.safeParse(marker.args).data?.title ?? null)
        : null;
    return {
      authorityKey: authorityKey(request.authority),
      request,
      assetId,
      marker,
      resolution: { phase: "loading", surface: loadingSurface(title) },
    };
  };

  return {
    sync(requests): void {
      if (disposed) return;
      let changed = false;
      const visible = new Map(
        requests
          .filter((request) => request.visible)
          .map((request) => [request.authority.renderableId, request]),
      );
      const retired: PreviewSlot[] = [];
      for (const [renderableId, slot] of slots) {
        const request = visible.get(renderableId);
        if (request && slot.authorityKey === authorityKey(request.authority)) {
          visible.delete(renderableId);
          continue;
        }
        retired.push(slot);
        slots.delete(renderableId);
        changed = true;
      }
      for (const [renderableId, request] of visible) {
        const slot = createSlot(request);
        if (!slot) continue;
        slots.set(renderableId, slot);
        changed = true;
        if (slot.assetId) retainAsset(slot.assetId, slot);
      }
      // Retain replacements before releasing retired authorities so a
      // same-asset generation transition never aborts/reloads its physical IO.
      for (const slot of retired) if (slot.assetId) releaseAsset(slot.assetId, slot);
      if (changed) notify();
    },
    publications: () =>
      [...slots.values()].map((slot) =>
        Object.freeze({ authority: slot.request.authority, resolution: slot.resolution }),
      ),
    getMetrics(): RichPreviewSessionMetrics {
      return {
        activePreviews: slots.size,
        cachedAssets: [...assets.values()].filter((job) => job.phase === "ready").length,
        inFlightAssets: [...assets.values()].filter((job) => job.phase === "loading").length,
        retainedBytes,
        loadsStarted,
        joinedLoads,
        loadsAborted,
        lateResultsDiscarded,
        cacheLimitRefusals,
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const job of assets.values()) {
        if (job.phase === "loading") {
          loadsAborted += 1;
          job.controller.abort(new DOMException("Rich preview disposed", "AbortError"));
        }
      }
      slots.clear();
      assets.clear();
      retainedBytes = 0;
    },
  };
}
