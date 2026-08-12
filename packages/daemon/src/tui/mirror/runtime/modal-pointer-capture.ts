export interface ModalPointerCaptureHost {
  readonly dragKind: "border" | "sidebar" | "scrollbar" | null;
  readonly cancelBorderResize: () => void;
  readonly clearDragging: () => void;
  readonly clearSelecting: () => void;
  readonly clearDragAutoScroll: () => void;
  readonly clearPendingPress: () => void;
  readonly clearForwardedDown: () => void;
  readonly clearVisuals: () => void;
}

/** Synchronous modal boundary: retire every pointer owner before any await. */
export function cancelModalPointerCapture(host: ModalPointerCaptureHost): void {
  if (host.dragKind === "border") host.cancelBorderResize();
  host.clearDragging();
  host.clearSelecting();
  host.clearDragAutoScroll();
  host.clearPendingPress();
  host.clearForwardedDown();
  host.clearVisuals();
}
