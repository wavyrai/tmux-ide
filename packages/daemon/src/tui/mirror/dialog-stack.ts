/**
 * Compatibility façade for the historical process-wide dialog stack.
 *
 * New application roots must import `dialog-stack-core.ts` and create an owned
 * stack. This module remains only until the current root finishes its cutover.
 */
import type {
  DialogConfirmSpec,
  DialogPromptSpec,
  DialogSelectResult,
  DialogSelectSpec,
} from "./dialog-model.ts";
import { createDialogStack, type DialogStack } from "./dialog-stack-core.ts";

export * from "./dialog-stack-core.ts";

/** @deprecated Use an application-owned stack from `createDialogStack()`. */
export const dialogStack = createDialogStack();

export const DialogSelect = {
  show(spec: Omit<DialogSelectSpec, "kind">, stack: DialogStack = dialogStack) {
    return stack.push({ kind: "select", ...spec }) as Promise<DialogSelectResult | null>;
  },
};

export const DialogPrompt = {
  show(spec: Omit<DialogPromptSpec, "kind">, stack: DialogStack = dialogStack) {
    return stack.push({ kind: "prompt", ...spec }) as Promise<string | null>;
  },
};

export const DialogConfirm = {
  show(spec: Omit<DialogConfirmSpec, "kind">, stack: DialogStack = dialogStack) {
    return stack.push({ kind: "confirm", ...spec }) as Promise<boolean>;
  },
};
