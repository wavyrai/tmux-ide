import { createRoot, createSignal, onCleanup } from "solid-js";

import {
  DIALOG_ROWS,
  dialogContains,
  dialogHeaderRows,
  dialogPos,
  dialogRowAt,
  type DialogGeom,
  type DialogSpec,
} from "../../dialog-model.ts";
import { createDialogStack, dialogKey } from "../../dialog-stack.ts";
import type {
  DialogConfirmRequest,
  DialogFeatureHost,
  DialogFeatureSession,
  DialogFeatureSnapshot,
  DialogPointerEvent,
  DialogPromptRequest,
  DialogSelectRequest,
} from "./contract.ts";

const CLOSED: DialogFeatureSnapshot = Object.freeze({ phase: "closed" });

function geometryFor(
  spec: DialogSpec,
  state: { readonly top: number },
  filteredCount: number,
  host: DialogFeatureHost,
): DialogGeom {
  const viewport = host.viewport();
  const width = Math.max(8, Math.min(viewport.dialogWidth, viewport.width));
  const position = dialogPos(viewport.width, viewport.height, width);
  const visibleRows =
    spec.kind === "select"
      ? Math.min(DIALOG_ROWS, Math.max(0, filteredCount - state.top))
      : spec.kind === "confirm"
        ? 2
        : 1;
  return {
    left: position.left,
    top: position.top,
    width,
    headerRows: dialogHeaderRows(spec, width),
    visibleRows,
    footerRows: 1,
  };
}

/**
 * Per-application dialog authority.
 *
 * Unlike the historical module singleton, every application root gets a
 * private stack and explicit Solid owner. Disposing the session synchronously
 * cancels all pending one-shots before retiring its reactive owner.
 */
export function createDialogFeatureSession(host: DialogFeatureHost): DialogFeatureSession {
  return createRoot((disposeOwner) => {
    const stack = createDialogStack();
    const [revision, setRevision] = createSignal(0);
    let isDisposed = false;
    let lastOpen = false;

    const publish = () => {
      if (isDisposed) return;
      setRevision((value) => value + 1);
      const nextOpen = stack.depth() > 0;
      if (nextOpen !== lastOpen) {
        lastOpen = nextOpen;
        host.onOpenChange?.(nextOpen);
      }
    };
    const unsubscribe = stack.subscribe(publish);
    onCleanup(unsubscribe);

    const snapshot = (): DialogFeatureSnapshot => {
      revision();
      if (isDisposed) return CLOSED;
      const entry = stack.top();
      if (!entry) return CLOSED;
      const filtered = entry.spec.kind === "select" ? stack.filtered() : [];
      const geometry = geometryFor(entry.spec, entry.state, filtered.length, host);
      return {
        phase: "open",
        spec: entry.spec,
        state: Object.freeze({ ...entry.state }),
        geometry,
        visibleItems:
          entry.spec.kind === "select"
            ? Object.freeze(filtered.slice(entry.state.top, entry.state.top + DIALOG_ROWS))
            : Object.freeze([]),
      };
    };

    const select = (request: DialogSelectRequest) =>
      isDisposed
        ? Promise.resolve(null)
        : (stack.push({ kind: "select", ...request }) as Promise<
            Awaited<ReturnType<DialogFeatureSession["select"]>>
          >);
    const prompt = (request: DialogPromptRequest) =>
      isDisposed
        ? Promise.resolve(null)
        : (stack.push({ kind: "prompt", ...request }) as Promise<
            Awaited<ReturnType<DialogFeatureSession["prompt"]>>
          >);
    const confirm = (request: DialogConfirmRequest) =>
      isDisposed
        ? Promise.resolve(false)
        : (stack.push({ kind: "confirm", ...request }) as Promise<boolean>);

    const handlePointer = (event: DialogPointerEvent): boolean => {
      if (isDisposed || stack.depth() === 0) return false;
      const current = snapshot();
      if (current.phase !== "open") return false;
      if (event.kind === "scroll") {
        if (
          current.spec.kind === "select" &&
          (event.scrollDirection === "up" || event.scrollDirection === "down")
        ) {
          stack.scrollBy(event.scrollDirection === "up" ? -1 : 1);
        }
        return true;
      }
      if (event.kind === "move") {
        const row = dialogRowAt(current.geometry, event.x, event.y);
        if (row >= 0) {
          if (current.spec.kind === "select") stack.setSel(current.state.top + row);
          else if (current.spec.kind === "confirm") stack.setSel(row);
        }
        return true;
      }
      if (event.kind !== "down") return true;
      const row = dialogRowAt(current.geometry, event.x, event.y);
      if (row >= 0) {
        if (current.spec.kind === "select") stack.activate(current.state.top + row);
        else if (current.spec.kind === "confirm") stack.choose(row);
        return true;
      }
      if (!dialogContains(current.geometry, event.x, event.y)) stack.dismiss();
      return true;
    };

    let session!: DialogFeatureSession;
    session = {
      open: () => !isDisposed && stack.depth() > 0,
      disposed: () => isDisposed,
      snapshot,
      select,
      prompt,
      confirm,
      handleKey(event) {
        if (isDisposed || stack.depth() === 0) return false;
        dialogKey(stack, event);
        return true;
      },
      handlePointer,
      dismiss() {
        if (isDisposed || stack.depth() === 0) return false;
        stack.dismiss();
        return true;
      },
      clear() {
        if (!isDisposed) stack.clear();
      },
      setBusy(busy) {
        if (isDisposed || stack.depth() === 0) return false;
        stack.setBusy(busy);
        return true;
      },
      dispose() {
        if (isDisposed) return;
        // Keep notifications alive through clear so the host observes the
        // modal release before this owner disappears.
        stack.clear();
        isDisposed = true;
        lastOpen = false;
        disposeOwner();
      },
    };
    return Object.freeze(session);
  });
}
