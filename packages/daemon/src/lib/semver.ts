// Strict SemVer precedence: numeric prerelease identifiers must not sort lexically.
export function parseStrictSemver(value: string) {
  if (value.length > 256) return null;
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      value,
    );
  if (!match) return null;
  const pre = match[4]?.split(".") ?? [];
  if (pre.some((part) => /^0\d+$/.test(part))) return null;
  return { core: match.slice(1, 4).map(BigInt), pre };
}

export function compareProductVersions(actual: string, expected: string): -1 | 0 | 1 | null {
  const a = parseStrictSemver(actual);
  const b = parseStrictSemver(expected);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i]! < b.core[i]! ? -1 : 1;
  }
  if (!a.pre.length || !b.pre.length)
    return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const left = a.pre[i];
    const right = b.pre[i];
    if (left === right) continue;
    if (left === undefined || right === undefined) return left === undefined ? -1 : 1;
    const ln = /^\d+$/.test(left);
    const rn = /^\d+$/.test(right);
    if (ln !== rn) return ln ? -1 : 1;
    return ln ? (BigInt(left) < BigInt(right) ? -1 : 1) : left < right ? -1 : 1;
  }
  return 0;
}
