import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface DesktopWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type DesktopDisplayWorkArea = DesktopWindowBounds;

export const DEFAULT_DESKTOP_WINDOW_BOUNDS: DesktopWindowBounds = {
  x: 96,
  y: 72,
  width: 1280,
  height: 820,
};

const MIN_WIDTH = 720;
const MIN_HEIGHT = 480;
const MAX_EXTENT = 16_384;
const COORDINATE_LIMIT = 1_000_000;
const MIN_VISIBLE_EDGE = 64;

function finiteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

export function parseDesktopWindowBounds(value: unknown): DesktopWindowBounds | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    !finiteInteger(record.x) ||
    !finiteInteger(record.y) ||
    !finiteInteger(record.width) ||
    !finiteInteger(record.height) ||
    Math.abs(record.x) > COORDINATE_LIMIT ||
    Math.abs(record.y) > COORDINATE_LIMIT ||
    record.width < MIN_WIDTH ||
    record.height < MIN_HEIGHT ||
    record.width > MAX_EXTENT ||
    record.height > MAX_EXTENT
  ) {
    return null;
  }
  return { x: record.x, y: record.y, width: record.width, height: record.height };
}

function visibleOnDisplay(bounds: DesktopWindowBounds, display: DesktopDisplayWorkArea): boolean {
  const overlapWidth =
    Math.min(bounds.x + bounds.width, display.x + display.width) - Math.max(bounds.x, display.x);
  const overlapHeight =
    Math.min(bounds.y + bounds.height, display.y + display.height) - Math.max(bounds.y, display.y);
  return overlapWidth >= MIN_VISIBLE_EDGE && overlapHeight >= MIN_VISIBLE_EDGE;
}

export function restoreDesktopWindowBounds(
  value: unknown,
  displays: readonly DesktopDisplayWorkArea[],
  fallback: DesktopWindowBounds = DEFAULT_DESKTOP_WINDOW_BOUNDS,
): DesktopWindowBounds {
  const parsed = parseDesktopWindowBounds(value);
  if (
    !parsed ||
    displays.length === 0 ||
    !displays.some((display) => visibleOnDisplay(parsed, display))
  ) {
    const primary = displays[0];
    if (!primary) return { ...fallback };
    const width = Math.min(fallback.width, primary.width);
    const height = Math.min(fallback.height, primary.height);
    return {
      x: primary.x + Math.max(0, Math.floor((primary.width - width) / 2)),
      y: primary.y + Math.max(0, Math.floor((primary.height - height) / 2)),
      width,
      height,
    };
  }
  return parsed;
}

export class DesktopWindowStateStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async read(): Promise<DesktopWindowBounds | null> {
    try {
      return parseDesktopWindowBounds(JSON.parse(await readFile(this.#path, "utf8")));
    } catch {
      return null;
    }
  }

  async write(bounds: DesktopWindowBounds): Promise<void> {
    const parsed = parseDesktopWindowBounds(bounds);
    if (!parsed) throw new Error("refusing to persist invalid desktop window bounds");
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.#path);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
