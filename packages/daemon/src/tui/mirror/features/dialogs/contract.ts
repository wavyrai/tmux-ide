import type {
  DialogConfirmSpec,
  DialogGeom,
  DialogPromptSpec,
  DialogSelectItem,
  DialogSelectResult,
  DialogSelectSpec,
  DialogSpec,
} from "../../dialog-model.ts";
import type { DialogEntryState, DialogKeyEvent } from "../../dialog-stack-core.ts";

export type DialogSelectRequest = Omit<DialogSelectSpec, "kind">;
export type DialogPromptRequest = Omit<DialogPromptSpec, "kind">;
export type DialogConfirmRequest = Omit<DialogConfirmSpec, "kind">;

export interface DialogFeatureViewport {
  readonly width: number;
  readonly height: number;
  readonly dialogWidth: number;
}

export interface DialogFeatureHost {
  /** Reactive when called inside a Solid owner. */
  readonly viewport: () => DialogFeatureViewport;
  readonly onOpenChange?: (open: boolean) => void;
}

export type DialogPointerKind = "move" | "down" | "scroll" | "up" | "out";

export interface DialogPointerEvent {
  readonly kind: DialogPointerKind;
  readonly x: number;
  readonly y: number;
  readonly scrollDirection?: "up" | "down";
}

export interface ClosedDialogFeatureSnapshot {
  readonly phase: "closed";
}

export interface OpenDialogFeatureSnapshot {
  readonly phase: "open";
  readonly spec: DialogSpec;
  readonly state: Readonly<DialogEntryState>;
  readonly geometry: DialogGeom;
  readonly visibleItems: readonly DialogSelectItem[];
}

export type DialogFeatureSnapshot = ClosedDialogFeatureSnapshot | OpenDialogFeatureSnapshot;

export interface DialogFeatureSession {
  readonly open: () => boolean;
  readonly disposed: () => boolean;
  readonly snapshot: () => DialogFeatureSnapshot;
  readonly select: (request: DialogSelectRequest) => Promise<DialogSelectResult | null>;
  readonly prompt: (request: DialogPromptRequest) => Promise<string | null>;
  readonly confirm: (request: DialogConfirmRequest) => Promise<boolean>;
  readonly handleKey: (event: DialogKeyEvent) => boolean;
  readonly handlePointer: (event: DialogPointerEvent) => boolean;
  readonly dismiss: () => boolean;
  readonly clear: () => void;
  readonly setBusy: (busy: boolean) => boolean;
  readonly dispose: () => void;
}
