"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { runAction, useActions, type Action } from "@/lib/actions";

const paletteListeners = new Set<() => void>();
let paletteOpen = false;

function emitPalette(): void {
  for (const listener of paletteListeners) listener();
}

function subscribePalette(listener: () => void): () => void {
  paletteListeners.add(listener);
  return () => paletteListeners.delete(listener);
}

function getPaletteSnapshot(): boolean {
  return paletteOpen;
}

export function openCommandPalette(): void {
  paletteOpen = true;
  emitPalette();
}

export function closeCommandPalette(): void {
  paletteOpen = false;
  emitPalette();
}

function useCommandPaletteOpen(): boolean {
  return useSyncExternalStore(subscribePalette, getPaletteSnapshot, getPaletteSnapshot);
}

function scoreAction(action: Action, query: string): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return 1;

  const haystack = `${action.label} ${(action.keywords ?? []).join(" ")}`.toLowerCase();
  let score = 0;
  let lastIndex = -1;

  for (const char of needle) {
    const index = haystack.indexOf(char, lastIndex + 1);
    if (index === -1) return 0;
    score += index === lastIndex + 1 ? 4 : 1;
    lastIndex = index;
  }

  if (haystack.includes(needle)) score += 12;
  if (haystack.startsWith(needle)) score += 8;
  return score;
}

function formatKeybind(keybind: string): string {
  return keybind
    .split("+")
    .map((part) => {
      const normalized = part.toLowerCase();
      if (normalized === "mod") return "⌘";
      if (normalized === "shift") return "⇧";
      if (normalized === "alt" || normalized === "option") return "⌥";
      if (normalized === "ctrl" || normalized === "control") return "⌃";
      return part.length === 1 ? part.toUpperCase() : part;
    })
    .join("");
}

export function CommandPalette() {
  const open = useCommandPaletteOpen();
  const actions = useActions((action) => !action.isAvailable || action.isAvailable());
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const matches = useMemo(() => {
    return actions
      .map((action) => ({ action, score: scoreAction(action, query) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.action.label.localeCompare(b.action.label))
      .map((item) => item.action);
  }, [actions, query]);

  const grouped = useMemo(() => {
    const groups = new Map<string, Action[]>();
    for (const action of matches) {
      const group = action.category ?? "Commands";
      groups.set(group, [...(groups.get(group) ?? []), action]);
    }
    return Array.from(groups.entries());
  }, [matches]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setActiveIndex((current) => Math.min(current, Math.max(0, matches.length - 1)));
  }, [matches.length, open]);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: PointerEvent) {
      const panel = panelRef.current;
      if (!panel || panel.contains(event.target as Node)) return;
      closeCommandPalette();
    }

    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function run(action: Action): void {
    runAction(action.id);
    closeCommandPalette();
  }

  if (!open) return null;

  let flatIndex = 0;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/35 pt-[18vh]">
      <div
        ref={panelRef}
        data-testid="command-palette"
        className="w-[min(480px,calc(100vw-32px))] overflow-hidden border border-[var(--border)] bg-[var(--surface)] shadow-2xl"
      >
        <input
          ref={inputRef}
          data-testid="palette-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closeCommandPalette();
              return;
            }
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActiveIndex((current) => Math.min(matches.length - 1, current + 1));
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((current) => Math.max(0, current - 1));
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              const action = matches[activeIndex];
              if (action) run(action);
            }
          }}
          placeholder="Type a command..."
          className="h-11 w-full border-b border-[var(--border-weak)] bg-[var(--bg)] px-3 text-[13px] text-[var(--fg)] outline-none placeholder:text-[var(--dim)]"
        />

        <div className="max-h-72 overflow-y-auto py-1">
          {grouped.map(([group, groupActions]) => (
            <div key={group}>
              <div className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-[0.08em] text-[var(--dim)]">
                {group}
              </div>
              {groupActions.map((action) => {
                const index = flatIndex;
                flatIndex += 1;
                const active = index === activeIndex;

                return (
                  <button
                    key={action.id}
                    type="button"
                    data-testid="palette-item"
                    data-active={active ? "true" : "false"}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => run(action)}
                    className={`flex w-full items-start gap-3 px-3 py-2 text-left transition-colors ${
                      active
                        ? "bg-[var(--surface-active)] text-[var(--accent)]"
                        : "text-[var(--fg)] hover:bg-[var(--surface-hover)]"
                    }`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px]">{action.label}</span>
                      {action.description && (
                        <span className="block truncate text-[11px] text-[var(--dim)]">
                          {action.description}
                        </span>
                      )}
                    </span>
                    {action.keybind && (
                      <kbd className="shrink-0 border border-[var(--border-weak)] bg-[var(--bg-weak)] px-1.5 py-0.5 text-[10px] text-[var(--dim)]">
                        {formatKeybind(action.keybind)}
                      </kbd>
                    )}
                  </button>
                );
              })}
            </div>
          ))}

          {matches.length === 0 && (
            <div className="px-3 py-8 text-center text-[var(--dim)]">no commands</div>
          )}
        </div>
      </div>
    </div>
  );
}
