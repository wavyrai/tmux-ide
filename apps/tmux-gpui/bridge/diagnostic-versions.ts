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
const versions = new WeakMap<PreviewHost, { value: string | null; current: () => void }>();
export function registerVerifiedVersion(host: PreviewHost, value: unknown, current: () => void) {
  const version = safeProductVersion(value);
  versions.set(host, { value: version, current });
}
export function verifiedHostCurrent(host: PreviewHost): boolean {
  const proof = versions.get(host);
  if (!proof) return false;
  try {
    proof.current();
    return true;
  } catch {
    return false;
  }
}

export function verifiedVersion(host: PreviewHost): string | null {
  return verifiedHostCurrent(host) ? (versions.get(host)?.value ?? null) : null;
}
