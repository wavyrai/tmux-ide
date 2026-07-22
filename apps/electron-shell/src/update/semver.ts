/**
 * A tiny, PURE semver comparator — the same lenient ordering the CLI updater
 * uses ({@link ../../../../packages/daemon/src/lib/update-check.ts}), reimplemented
 * locally so the Electron shell need not pull the daemon package. Malformed
 * versions coerce to `0.0.0` rather than throwing, and prerelease tags sort below
 * their release of the same core.
 */
interface ParsedSemver {
  readonly nums: readonly [number, number, number];
  readonly pre: string;
}

function parseSemver(version: string): ParsedSemver {
  const core = version.trim().replace(/^v/iu, "").split("+")[0] ?? "";
  const dash = core.indexOf("-");
  const main = dash === -1 ? core : core.slice(0, dash);
  const pre = dash === -1 ? "" : core.slice(dash + 1);
  const parts = main.split(".");
  const num = (index: number): number => {
    const value = Number.parseInt(parts[index] ?? "", 10);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  };
  return { nums: [num(0), num(1), num(2)], pre };
}

/** PURE — `-1` if `a < b`, `1` if `a > b`, else `0`. Numeric core, then prerelease. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let index = 0; index < 3; index += 1) {
    const left = pa.nums[index] ?? 0;
    const right = pb.nums[index] ?? 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === "") return 1;
  if (pb.pre === "") return -1;
  return pa.pre < pb.pre ? -1 : 1;
}
