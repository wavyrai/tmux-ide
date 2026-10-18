import type { PreviewHost } from "./config.ts";

export function safeProductVersion(value: unknown): string | null {
  return typeof value === "string" &&
    value.length <= 64 &&
    /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(
      value,
    )
    ? value
    : null;
}
// Only discovery/probe owners register exact host objects, never parsed host files.
const versions = new WeakMap<PreviewHost, () => string | null>();
export function registerVerifiedVersion(host: PreviewHost, value: unknown, current: () => void) {
  const version = safeProductVersion(value);
  versions.set(host, () => {
    try {
      current();
      return version;
    } catch {
      return null;
    }
  });
}
export function verifiedVersion(host: PreviewHost): string | null {
  return versions.get(host)?.() ?? null;
}
