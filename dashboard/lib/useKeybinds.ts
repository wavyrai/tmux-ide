"use client";

import { useEffect } from "react";
import type { Action } from "./actions";
import { runAction } from "./actions";

interface UseKeybindOptions {
  allowInput?: boolean;
}

interface ParsedKeybind {
  key: string;
  /** Mod = "Cmd OR Ctrl" — matches the platform-appropriate one without requiring strict detection. */
  mod: boolean;
  /** Strict Ctrl-only (use "Ctrl+X" in the keybind string). */
  ctrl: boolean;
  /** Strict Cmd/Meta only (use "Cmd+X" / "Meta+X" in the keybind string). */
  meta: boolean;
  shift: boolean;
  alt: boolean;
}

export function parseKeybind(keybind: string): ParsedKeybind {
  const parts = keybind.split("+").map((part) => part.trim());
  const key = parts.pop() ?? "";
  const parsed: ParsedKeybind = {
    key: key.toLowerCase(),
    mod: false,
    ctrl: false,
    meta: false,
    shift: false,
    alt: false,
  };

  for (const part of parts) {
    const normalized = part.toLowerCase();
    if (normalized === "mod") {
      parsed.mod = true;
    } else if (normalized === "meta" || normalized === "cmd") {
      parsed.meta = true;
    } else if (normalized === "ctrl" || normalized === "control") {
      parsed.ctrl = true;
    } else if (normalized === "shift") {
      parsed.shift = true;
    } else if (normalized === "alt" || normalized === "option") {
      parsed.alt = true;
    }
  }

  return parsed;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true;
  return target.isContentEditable;
}

export function matchesKeybind(event: KeyboardEvent, parsed: ParsedKeybind): boolean {
  if (event.key.toLowerCase() !== parsed.key) return false;
  if (parsed.mod) {
    // Either Cmd OR Ctrl satisfies Mod, but not neither.
    if (!event.metaKey && !event.ctrlKey) return false;
  } else {
    if (event.metaKey !== parsed.meta) return false;
    if (event.ctrlKey !== parsed.ctrl) return false;
  }
  return event.shiftKey === parsed.shift && event.altKey === parsed.alt;
}

export function useKeybind(key: string, handler: () => void, opts: UseKeybindOptions = {}): void {
  useEffect(() => {
    const parsed = parseKeybind(key);

    const onKeydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (!opts.allowInput && isEditableTarget(document.activeElement)) return;
      if (!matchesKeybind(event, parsed)) return;
      event.preventDefault();
      handler();
    };

    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  }, [handler, key, opts.allowInput]);
}

export function registerKeybindFromAction(action: Action): () => void {
  if (typeof window === "undefined" || !action.keybind) return () => undefined;

  const parsed = parseKeybind(action.keybind);
  const onKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    if (isEditableTarget(document.activeElement)) return;
    if (!matchesKeybind(event, parsed)) return;
    event.preventDefault();
    runAction(action.id);
  };

  window.addEventListener("keydown", onKeydown);
  return () => window.removeEventListener("keydown", onKeydown);
}
