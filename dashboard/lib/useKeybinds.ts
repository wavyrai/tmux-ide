"use client";

import { useEffect } from "react";

interface UseKeybindOptions {
  allowInput?: boolean;
}

interface ParsedKeybind {
  key: string;
  meta: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform);
}

function parseKeybind(keybind: string): ParsedKeybind {
  const parts = keybind.split("+").map((part) => part.trim());
  const key = parts.pop() ?? "";
  const parsed: ParsedKeybind = {
    key: key.toLowerCase(),
    meta: false,
    ctrl: false,
    shift: false,
    alt: false,
  };

  for (const part of parts) {
    const normalized = part.toLowerCase();
    if (normalized === "mod") {
      if (isMac()) parsed.meta = true;
      else parsed.ctrl = true;
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

function matches(event: KeyboardEvent, parsed: ParsedKeybind): boolean {
  return (
    event.key.toLowerCase() === parsed.key &&
    event.metaKey === parsed.meta &&
    event.ctrlKey === parsed.ctrl &&
    event.shiftKey === parsed.shift &&
    event.altKey === parsed.alt
  );
}

export function useKeybind(key: string, handler: () => void, opts: UseKeybindOptions = {}): void {
  useEffect(() => {
    const parsed = parseKeybind(key);

    const onKeydown = (event: KeyboardEvent) => {
      if (!opts.allowInput && isEditableTarget(document.activeElement)) return;
      if (!matches(event, parsed)) return;
      event.preventDefault();
      handler();
    };

    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  }, [handler, key, opts.allowInput]);
}
