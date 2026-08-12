import type {
  TerminalReplicaPlacement,
  TerminalReplicaSnapshot,
  WidgetAssetId,
  WidgetAssetMediaType,
} from "@tmux-ide/contracts";

import type { TuiWidgetSurface } from "../../widget-surface-model.ts";

/** Exact authority for one async rich-preview publication. Geometry is absent by design. */
export interface RichPreviewAuthorityToken {
  readonly workspaceId: string;
  readonly workspaceGeneration: string;
  readonly paneId: string;
  readonly paneGeneration: string;
  readonly renderableId: string;
  readonly contentDigest: string;
}

export interface RichPreviewRequest {
  readonly authority: RichPreviewAuthorityToken;
  /** Retained canonical reference. Callers must not clone its terminal grids. */
  readonly snapshot: TerminalReplicaSnapshot;
  readonly placement: TerminalReplicaPlacement;
  readonly visible: boolean;
}

export interface RichPreviewAsset {
  readonly assetId: WidgetAssetId;
  readonly media: WidgetAssetMediaType;
  readonly name: string;
  readonly byteLength: number;
  readonly bytes: Uint8Array;
}

export type RichPreviewAssetLoadResult =
  | { readonly status: "ok"; readonly asset: RichPreviewAsset }
  | {
      readonly status: "error";
      readonly reason:
        | "aborted"
        | "invalid-id"
        | "unavailable"
        | "unsafe-path"
        | "invalid-metadata"
        | "too-large"
        | "hash-mismatch";
    };

export interface RichPreviewHost {
  readonly loadAsset: (
    assetId: WidgetAssetId,
    signal: AbortSignal,
  ) => Promise<RichPreviewAssetLoadResult>;
  readonly onChange: () => void;
  /** Runs after a committed native frame, not merely after a JS microtask. */
  readonly afterNativeFrame: (callback: () => void) => void;
  readonly capabilities?: {
    /** Generic OpenTUI terminals do not negotiate a raster pixel protocol. */
    readonly rasterImages?: boolean;
  };
}

export type RichPreviewResolution =
  | { readonly phase: "loading"; readonly surface: TuiWidgetSurface }
  | {
      readonly phase: "ready" | "fallback";
      readonly surface: TuiWidgetSurface;
      readonly retainedBytes: number;
    };

export interface RichPreviewPublication {
  readonly authority: RichPreviewAuthorityToken;
  readonly resolution: RichPreviewResolution;
}

export interface RichPreviewSessionMetrics {
  readonly activePreviews: number;
  readonly cachedAssets: number;
  readonly inFlightAssets: number;
  readonly retainedBytes: number;
  readonly loadsStarted: number;
  readonly joinedLoads: number;
  readonly loadsAborted: number;
  readonly lateResultsDiscarded: number;
  readonly cacheLimitRefusals: number;
}

export interface RichPreviewSession {
  readonly sync: (requests: readonly RichPreviewRequest[]) => void;
  readonly publications: () => readonly RichPreviewPublication[];
  readonly getMetrics: () => RichPreviewSessionMetrics;
  readonly dispose: () => void;
}
