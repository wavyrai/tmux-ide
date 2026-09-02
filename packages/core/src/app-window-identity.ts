import {
  APP_WINDOW_MAX_WINDOWS,
  AppWindowIdSchemaZ,
  AppWindowSourceSchemaZ,
  type AppWindowSource,
} from "@tmux-ide/contracts";

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0");
}

/** Stable renderer-neutral instance identity derived only from durable source identity. */
export function stableAppWindowInstanceId(source: AppWindowSource, ordinal = 0): string {
  const parsed = AppWindowSourceSchemaZ.parse(source);
  if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= APP_WINDOW_MAX_WINDOWS) {
    throw new Error("app window ordinal must be a bounded nonnegative integer");
  }
  const sourceKey =
    parsed.kind === "terminal"
      ? `terminal:${parsed.terminalSourceId}`
      : `native:${parsed.surface}:${parsed.resourceId === null ? "null" : `id:${parsed.resourceId}`}`;
  const slug = sourceKey
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 72);
  return AppWindowIdSchemaZ.parse(`window-${slug || "surface"}-${ordinal}-${fnv1a(sourceKey)}`);
}
