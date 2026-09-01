import type { ResolvedThemeMode } from "../../../lib/theme-mode.ts";

export type ApplicationTerminalPaletteAvailability = "pending" | "available" | "unavailable";

export interface ApplicationTerminalPaletteColors {
  readonly palette: readonly (string | null)[];
  readonly defaultForeground: string | null;
  readonly defaultBackground: string | null;
  readonly cursorColor: string | null;
  readonly mouseForeground: string | null;
  readonly mouseBackground: string | null;
  readonly tekForeground: string | null;
  readonly tekBackground: string | null;
  readonly highlightBackground: string | null;
  readonly highlightForeground: string | null;
}

export interface ApplicationTerminalPaletteSnapshot extends ApplicationTerminalPaletteColors {
  readonly availability: ApplicationTerminalPaletteAvailability;
  readonly detectedMode: ResolvedThemeMode;
  /** Renderer capability data projected to immutable, renderer-neutral values. */
  readonly capabilities: Readonly<Record<string, unknown>> | null;
  readonly signature: string;
}

interface PaletteQueryResult {
  readonly palette?: readonly (string | null)[];
  readonly defaultForeground?: string | null;
  readonly defaultBackground?: string | null;
  readonly cursorColor?: string | null;
  readonly mouseForeground?: string | null;
  readonly mouseBackground?: string | null;
  readonly tekForeground?: string | null;
  readonly tekBackground?: string | null;
  readonly highlightBackground?: string | null;
  readonly highlightForeground?: string | null;
}

export interface ApplicationTerminalPaletteRenderer {
  readonly themeMode: ResolvedThemeMode | null;
  readonly capabilities: unknown;
  clearPaletteCache(): void;
  getPalette(options: { size: number; timeout: number }): Promise<PaletteQueryResult>;
  on(event: "theme_mode", listener: (mode: ResolvedThemeMode) => void): unknown;
  off(event: "theme_mode", listener: (mode: ResolvedThemeMode) => void): unknown;
  on(event: "capabilities", listener: (capabilities: unknown) => void): unknown;
  off(event: "capabilities", listener: (capabilities: unknown) => void): unknown;
  prependInputHandler(handler: (sequence: string) => boolean): void;
  removeInputHandler(handler: (sequence: string) => boolean): void;
}

export interface ApplicationTerminalPaletteOwnerOptions {
  /** Palette requests must settle without holding application readiness forever. */
  readonly queryTimeoutMs?: number;
  /** Theme-mode notifications only refresh host colors while system mode is unlocked. */
  readonly isThemeModeUnlocked?: () => boolean;
  readonly setTimeout?: typeof globalThis.setTimeout;
  readonly clearTimeout?: typeof globalThis.clearTimeout;
}

export interface ApplicationTerminalPaletteOwner {
  readonly ready: Promise<void>;
  getSnapshot(): ApplicationTerminalPaletteSnapshot;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  dispose(): void;
}

const PALETTE_SIZE = 16;
const QUERY_TIMEOUT_MS = 1_000;
const FOLLOW_UP_DELAYS_MS = [250, 1_000] as const;
const EMPTY_PALETTE = Object.freeze(Array<string | null>(PALETTE_SIZE).fill(null));

function normalizeColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function normalizePalette(values: unknown): readonly (string | null)[] {
  const palette = Array<string | null>(PALETTE_SIZE).fill(null);
  if (Array.isArray(values))
    for (let index = 0; index < PALETTE_SIZE; index += 1)
      palette[index] = normalizeColor(values[index]);
  return Object.freeze(palette);
}

function immutableValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map(immutableValue));
  const record = value as Record<string, unknown>;
  const clone: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) clone[key] = immutableValue(record[key]);
  return Object.freeze(clone);
}

function immutableCapabilities(value: unknown): Readonly<Record<string, unknown>> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return immutableValue(value) as Readonly<Record<string, unknown>>;
}

function detectedMode(background: string | null, fallback: ResolvedThemeMode): ResolvedThemeMode {
  if (!background) return fallback;
  const match = /^#([\da-f]{3}|[\da-f]{6})$/iu.exec(background);
  if (!match) return fallback;
  const hex = match[1]!;
  const expanded =
    hex.length === 3 ? `${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}` : hex;
  const red = Number.parseInt(expanded.slice(0, 2), 16) / 255;
  const green = Number.parseInt(expanded.slice(2, 4), 16) / 255;
  const blue = Number.parseInt(expanded.slice(4, 6), 16) / 255;
  return 0.299 * red + 0.587 * green + 0.114 * blue > 0.5 ? "light" : "dark";
}

function snapshotSignature(input: Omit<ApplicationTerminalPaletteSnapshot, "signature">): string {
  return JSON.stringify(input);
}

function freezeSnapshot(
  input: Omit<ApplicationTerminalPaletteSnapshot, "signature">,
): ApplicationTerminalPaletteSnapshot {
  return Object.freeze({ ...input, signature: snapshotSignature(input) });
}

function fallbackSnapshot(
  availability: "pending" | "unavailable",
  mode: ResolvedThemeMode,
  capabilities: Readonly<Record<string, unknown>> | null,
): ApplicationTerminalPaletteSnapshot {
  return freezeSnapshot({
    availability,
    palette: EMPTY_PALETTE,
    defaultForeground: null,
    defaultBackground: null,
    cursorColor: null,
    mouseForeground: null,
    mouseBackground: null,
    tekForeground: null,
    tekBackground: null,
    highlightBackground: null,
    highlightForeground: null,
    detectedMode: mode,
    capabilities,
  });
}

function availableSnapshot(
  result: PaletteQueryResult,
  fallbackMode: ResolvedThemeMode,
  capabilities: Readonly<Record<string, unknown>> | null,
): ApplicationTerminalPaletteSnapshot {
  const defaultBackground = normalizeColor(result.defaultBackground);
  return freezeSnapshot({
    availability: "available",
    palette: normalizePalette(result.palette),
    defaultForeground: normalizeColor(result.defaultForeground),
    defaultBackground,
    cursorColor: normalizeColor(result.cursorColor),
    mouseForeground: normalizeColor(result.mouseForeground),
    mouseBackground: normalizeColor(result.mouseBackground),
    tekForeground: normalizeColor(result.tekForeground),
    tekBackground: normalizeColor(result.tekBackground),
    highlightBackground: normalizeColor(result.highlightBackground),
    highlightForeground: normalizeColor(result.highlightForeground),
    detectedMode: detectedMode(defaultBackground, fallbackMode),
    capabilities,
  });
}

function hasReportedColor(result: PaletteQueryResult): boolean {
  return (
    normalizeColor(result.defaultForeground) !== null ||
    normalizeColor(result.defaultBackground) !== null ||
    (Array.isArray(result.palette) &&
      result.palette.some((color) => normalizeColor(color) !== null))
  );
}

export function createApplicationTerminalPaletteOwner(
  renderer: ApplicationTerminalPaletteRenderer,
  options: ApplicationTerminalPaletteOwnerOptions = {},
): ApplicationTerminalPaletteOwner {
  const queryTimeoutMs = Math.max(1, options.queryTimeoutMs ?? QUERY_TIMEOUT_MS);
  const scheduleTimeout = options.setTimeout ?? globalThis.setTimeout;
  const cancelTimeout = options.clearTimeout ?? globalThis.clearTimeout;
  const isThemeModeUnlocked = options.isThemeModeUnlocked ?? (() => true);
  const listeners = new Set<() => void>();
  const timers = new Set<ReturnType<typeof globalThis.setTimeout>>();
  let capabilities = immutableCapabilities(renderer.capabilities);
  let snapshot = fallbackSnapshot("pending", renderer.themeMode ?? "dark", capabilities);
  let lastValid: ApplicationTerminalPaletteSnapshot | null = null;
  let active: Promise<void> | null = null;
  let queued = false;
  let disposed = false;

  const publish = (next: ApplicationTerminalPaletteSnapshot): void => {
    if (disposed || next.signature === snapshot.signature) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (active) {
      queued = true;
      return active;
    }
    renderer.clearPaletteCache();
    const generation = Promise.resolve()
      .then(() => renderer.getPalette({ size: PALETTE_SIZE, timeout: queryTimeoutMs }))
      .then((result) => {
        if (disposed) return;
        if (!hasReportedColor(result)) {
          if (!lastValid)
            publish(fallbackSnapshot("unavailable", renderer.themeMode ?? "dark", capabilities));
          return;
        }
        const next = availableSnapshot(result, renderer.themeMode ?? "dark", capabilities);
        lastValid = next;
        publish(next);
      })
      .catch(() => {
        if (disposed || lastValid) return;
        publish(fallbackSnapshot("unavailable", renderer.themeMode ?? "dark", capabilities));
      })
      .finally(() => {
        if (active !== generation) return;
        active = null;
        if (disposed || !queued) return;
        queued = false;
        void refresh();
      });
    active = generation;
    return generation;
  };

  const scheduleFollowUps = (): void => {
    if (disposed) return;
    void refresh();
    for (const delay of FOLLOW_UP_DELAYS_MS) {
      const timer = scheduleTimeout(() => {
        timers.delete(timer);
        if (!disposed) void refresh();
      }, delay);
      timers.add(timer);
    }
  };

  const onThemeMode = (): void => {
    if (isThemeModeUnlocked()) scheduleFollowUps();
  };
  const onCapabilities = (next: unknown): void => {
    capabilities = immutableCapabilities(next);
    if (lastValid) {
      const valid = { ...lastValid, capabilities };
      Reflect.deleteProperty(valid, "signature");
      lastValid = freezeSnapshot(valid);
      publish(lastValid);
      return;
    }
    publish(
      fallbackSnapshot(
        snapshot.availability === "pending" ? "pending" : "unavailable",
        renderer.themeMode ?? "dark",
        capabilities,
      ),
    );
  };
  const onThemeNotification = (sequence: string): boolean => {
    if (sequence !== "\x1b[?997;1n" && sequence !== "\x1b[?997;2n") return false;
    if (isThemeModeUnlocked()) scheduleFollowUps();
    return false;
  };

  renderer.on("theme_mode", onThemeMode);
  renderer.on("capabilities", onCapabilities);
  renderer.prependInputHandler(onThemeNotification);
  const ready = refresh();

  return {
    ready,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      queued = false;
      renderer.off("theme_mode", onThemeMode);
      renderer.off("capabilities", onCapabilities);
      renderer.removeInputHandler(onThemeNotification);
      for (const timer of timers) cancelTimeout(timer);
      timers.clear();
      listeners.clear();
      active = null;
    },
  };
}
