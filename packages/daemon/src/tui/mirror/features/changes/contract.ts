import type { WorkspaceChangesCatalogEnvelopeV1 } from "@tmux-ide/contracts";

import type { ChangesSurfaceProjection } from "../../changes-surface.ts";

export interface ChangesKeyEvent {
  readonly name: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
}

export type ChangesHoverTarget =
  | { readonly kind: "header-action"; readonly index: number }
  | { readonly kind: "list-row"; readonly index: number }
  | { readonly kind: "footer-action"; readonly index: number };

export type ChangesPointerEvent =
  | {
      readonly type: "down";
      readonly x: number;
      readonly y: number;
      readonly button?: number;
    }
  | {
      readonly type: "scroll";
      readonly x: number;
      readonly y: number;
      readonly direction: "up" | "down";
      readonly scrollStep?: number;
      /** Dock chrome ignores wheel input; the legacy full surface scrolls its diff. */
      readonly outsideBody: "ignore" | "diff";
    };

export interface ChangesContextTarget {
  readonly title: string;
  readonly path: string;
}

export interface ChangesScrollState {
  readonly contentLength: number;
  readonly viewportRows: number;
  readonly top: number;
}

export interface ChangesFeatureHost {
  readonly width: () => number;
  readonly height: () => number;
  readonly hover: () => ChangesHoverTarget | null;
  readonly refreshResource: () => void;
  readonly setStatusNote: (message: string) => void;
  readonly openEditor: (path: string, line?: number) => void;
  readonly runGit: (
    directory: string,
    args: readonly string[],
    callback: (stdout: string) => void,
  ) => void;
  readonly readFile: (path: string) => Uint8Array;
}

export interface ChangesFeatureSession {
  readonly projection: () => ChangesSurfaceProjection;
  readonly directory: () => string;
  readonly hasEntries: () => boolean;
  readonly hasSelection: () => boolean;
  readonly selectedPath: () => string | null;
  readonly filterOpen: () => boolean;
  readonly prepare: (directory: string) => void;
  readonly reset: (message?: string) => void;
  readonly applyCatalog: (catalog: WorkspaceChangesCatalogEnvelopeV1) => void;
  readonly restoreSelectedPath: (path: string | null) => void;
  readonly handleKey: (event: ChangesKeyEvent, mode: "filter" | "surface") => boolean;
  readonly hoverTargetAt: (x: number, y: number) => ChangesHoverTarget | null;
  readonly handlePointer: (event: ChangesPointerEvent) => boolean;
  readonly contextTargetAt: (x: number, y: number) => ChangesContextTarget | null;
  readonly scrollState: () => ChangesScrollState;
  readonly setScrollTop: (top: number) => void;
  readonly dispose: () => void;
}
