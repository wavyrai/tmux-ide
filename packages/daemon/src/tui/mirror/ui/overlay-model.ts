export type OverlayDismissReason = "escape" | "outside-press" | "action";
export type OverlayPlacement = "center" | "anchor" | "top-right";

export interface OverlayHostEntry {
  readonly id: string;
  readonly modal?: boolean;
  readonly dismissOnEscape?: boolean;
}

export interface OverlayFocusCoordinator {
  sync(ids: readonly string[]): void;
  dispose(): void;
}

export function overlayTopmost<T>(entries: readonly T[]): T | null {
  return entries.at(-1) ?? null;
}

export function overlayZIndex(index: number): number {
  return 100 + Math.max(0, Math.floor(index)) * 10;
}

export function overlayEscapeTarget(
  entries: readonly OverlayHostEntry[],
  key: string,
): string | null {
  if (!new Set(["escape", "esc"]).has(key.toLowerCase())) return null;
  const top = [...entries].reverse().find(({ modal }) => modal !== false) ?? null;
  return top && top.dismissOnEscape !== false ? top.id : null;
}

export function overlayFrameSize(input: {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly preferredWidth: number;
  readonly preferredHeight: number;
}): Readonly<{ width: number; height: number }> {
  const viewportWidth = Math.max(1, Math.floor(input.viewportWidth));
  const viewportHeight = Math.max(1, Math.floor(input.viewportHeight));
  const horizontalInset = viewportWidth >= 80 ? 4 : viewportWidth >= 24 ? 2 : 0;
  const verticalInset = viewportHeight >= 5 ? 2 : 0;
  return Object.freeze({
    width: Math.max(1, Math.min(Math.floor(input.preferredWidth), viewportWidth - horizontalInset)),
    height: Math.max(
      3,
      Math.min(Math.floor(input.preferredHeight), viewportHeight - verticalInset),
    ),
  });
}

/** Saves focus once for a stack and restores it only after the final overlay closes. */
export function createOverlayFocusCoordinator(options: {
  readonly capture: () => string | null;
  readonly mounted: (focusId: string) => boolean;
  readonly restore: (focusId: string) => void;
}): OverlayFocusCoordinator {
  let openIds: readonly string[] = [];
  let savedFocus: string | null = null;
  return {
    sync(ids) {
      const next = [...new Set(ids)];
      if (openIds.length === 0 && next.length > 0) savedFocus = options.capture();
      if (openIds.length > 0 && next.length === 0) {
        const restore = savedFocus;
        savedFocus = null;
        if (restore && options.mounted(restore)) options.restore(restore);
      }
      openIds = next;
    },
    dispose() {
      openIds = [];
      savedFocus = null;
    },
  };
}
