/**
 * Three-way merge — pure module, no Solid / Monaco / I/O deps.
 *
 * Splits the three sides into lines, walks them in parallel via
 * Longest-Common-Subsequence (LCS) alignments between
 * base ↔ external and base ↔ local, and emits a sequence of
 * `MergeHunk`s. Each hunk is one of four kinds:
 *
 *   - `unchanged`     — same in all three; auto-resolved.
 *   - `external-only` — external diverges, local matches base;
 *                       auto-resolved to the external lines.
 *   - `local-only`    — local diverges, external matches base;
 *                       auto-resolved to the local lines.
 *   - `conflict`      — both sides diverge; the host surfaces an
 *                       Apply / Keep / Combine choice.
 *
 * `applyResolutions(hunks, resolutions)` joins the resolved
 * content back into a single string, in the same line-by-line
 * shape the host produces via Monaco.
 *
 * Newline handling is conservative: every line is rejoined with
 * `\n`. Mixed CRLF input is normalized at the seam — a quirk the
 * editor flow has tolerated since G17-P5 because the daemon's
 * file-write endpoint preserves whatever the editor emits.
 */

export type HunkKind = "unchanged" | "external-only" | "local-only" | "conflict";

export interface MergeHunk {
  /** Sequential index in the parent hunk list — used as a key. */
  index: number;
  kind: HunkKind;
  baseLines: string[];
  externalLines: string[];
  localLines: string[];
  /**
   * 1-based base line number where this hunk begins, for UI
   * labeling. Hunks with zero base lines (pure-append tails) use
   * the previous hunk's trailing line + 1.
   */
  baseStartLine: number;
}

export type ConflictChoice = "external" | "local" | "combine";

/** Per-hunk resolution. Keyed by `hunk.index`. */
export interface Resolution {
  /**
   * The selected choice for a conflict hunk. `null` means
   * unresolved (a conflict the user hasn't picked yet).
   * Non-conflict hunks ignore this field — they auto-apply.
   */
  choice: ConflictChoice | null;
}

// ---------------------------------------------------------------------
// LCS pair backtrace
// ---------------------------------------------------------------------

/**
 * Return the list of `[aIdx, bIdx]` pairs forming a Longest
 * Common Subsequence of `a` and `b`. Standard O(m·n) DP with a
 * backtrace pass. Pairs are returned in increasing index order
 * for both sides.
 */
export function lcsPairs<T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>): Array<[number, number]> {
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0) return [];
  // Flat array indexed as (m+1) × (n+1) → row-major.
  const dp = new Int32Array((m + 1) * (n + 1));
  const stride = n + 1;
  for (let i = 0; i < m; i += 1) {
    for (let j = 0; j < n; j += 1) {
      if (a[i] === b[j]) {
        dp[(i + 1) * stride + (j + 1)] = (dp[i * stride + j] ?? 0) + 1;
      } else {
        const up = dp[i * stride + (j + 1)] ?? 0;
        const left = dp[(i + 1) * stride + j] ?? 0;
        dp[(i + 1) * stride + (j + 1)] = up >= left ? up : left;
      }
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      pairs.push([i - 1, j - 1]);
      i -= 1;
      j -= 1;
    } else {
      const up = dp[(i - 1) * stride + j] ?? 0;
      const left = dp[i * stride + (j - 1)] ?? 0;
      if (up >= left) i -= 1;
      else j -= 1;
    }
  }
  pairs.reverse();
  return pairs;
}

// ---------------------------------------------------------------------
// Three-way merge
// ---------------------------------------------------------------------

function splitLines(s: string): string[] {
  // Keep the trailing-newline edge case explicit: an empty input
  // produces zero lines; a single trailing newline produces one
  // empty trailing line so `applyResolutions` round-trips faithfully.
  if (s.length === 0) return [];
  return s.split("\n");
}

function classify(baseSlice: string[], externalSlice: string[], localSlice: string[]): HunkKind {
  const baseStr = baseSlice.join("\n");
  const externalStr = externalSlice.join("\n");
  const localStr = localSlice.join("\n");
  const externalChanged = externalStr !== baseStr;
  const localChanged = localStr !== baseStr;
  if (externalChanged && localChanged) {
    return externalStr === localStr ? "unchanged" : "conflict";
  }
  if (externalChanged) return "external-only";
  if (localChanged) return "local-only";
  return "unchanged";
}

/**
 * Diff three text blobs into a sequence of hunks. Pure: same
 * inputs always produce the same hunks.
 */
export function threeWayMerge(base: string, external: string, local: string): MergeHunk[] {
  const baseLines = splitLines(base);
  const externalLines = splitLines(external);
  const localLines = splitLines(local);

  // Map base line index → matched external / local line index.
  // The LCS guarantees monotonically-increasing right-hand indices.
  const eMap = new Map<number, number>();
  for (const [b, e] of lcsPairs(baseLines, externalLines)) eMap.set(b, e);
  const lMap = new Map<number, number>();
  for (const [b, l] of lcsPairs(baseLines, localLines)) lMap.set(b, l);

  // Anchors: base lines that appear in BOTH external and local. We
  // emit each anchor as a one-line `unchanged` hunk; between
  // anchors we emit a single hunk with whatever lines drifted on
  // each side.
  const anchors: number[] = [];
  for (let i = 0; i < baseLines.length; i += 1) {
    if (eMap.has(i) && lMap.has(i)) anchors.push(i);
  }

  const hunks: MergeHunk[] = [];
  let bIdx = 0;
  let eIdx = 0;
  let lIdx = 0;

  const pushHunk = (
    baseSlice: string[],
    externalSlice: string[],
    localSlice: string[],
    baseStartLine: number,
  ): void => {
    if (baseSlice.length === 0 && externalSlice.length === 0 && localSlice.length === 0) {
      return;
    }
    hunks.push({
      index: hunks.length,
      kind: classify(baseSlice, externalSlice, localSlice),
      baseLines: baseSlice,
      externalLines: externalSlice,
      localLines: localSlice,
      baseStartLine,
    });
  };

  for (const anchor of anchors) {
    const targetE = eMap.get(anchor)!;
    const targetL = lMap.get(anchor)!;
    if (anchor > bIdx || targetE > eIdx || targetL > lIdx) {
      // Drift between the previous anchor and this one.
      const baseSlice = baseLines.slice(bIdx, anchor);
      const externalSlice = externalLines.slice(eIdx, targetE);
      const localSlice = localLines.slice(lIdx, targetL);
      pushHunk(baseSlice, externalSlice, localSlice, bIdx + 1);
    }
    // The anchor line itself is identical across all three.
    pushHunk([baseLines[anchor]!], [externalLines[targetE]!], [localLines[targetL]!], anchor + 1);
    bIdx = anchor + 1;
    eIdx = targetE + 1;
    lIdx = targetL + 1;
  }
  // Tail after the last anchor.
  if (bIdx < baseLines.length || eIdx < externalLines.length || lIdx < localLines.length) {
    const baseSlice = baseLines.slice(bIdx);
    const externalSlice = externalLines.slice(eIdx);
    const localSlice = localLines.slice(lIdx);
    pushHunk(baseSlice, externalSlice, localSlice, bIdx + 1);
  }
  return hunks;
}

// ---------------------------------------------------------------------
// Resolution → merged content
// ---------------------------------------------------------------------

/**
 * Build a fresh resolution map from a hunk list. Conflict hunks
 * start with `choice: null`; other kinds are intentionally absent
 * (they auto-apply via `applyResolutions`).
 */
export function emptyResolutions(hunks: ReadonlyArray<MergeHunk>): Record<number, Resolution> {
  const out: Record<number, Resolution> = {};
  for (const h of hunks) {
    if (h.kind === "conflict") out[h.index] = { choice: null };
  }
  return out;
}

/** Total number of conflicts; used by the status bar. */
export function conflictCount(hunks: ReadonlyArray<MergeHunk>): number {
  let n = 0;
  for (const h of hunks) if (h.kind === "conflict") n += 1;
  return n;
}

/**
 * Tally how many conflict hunks have a non-null `choice` in
 * `resolutions`. Non-conflict hunks are skipped — they always
 * count as resolved.
 */
export function resolvedCount(
  hunks: ReadonlyArray<MergeHunk>,
  resolutions: Record<number, Resolution>,
): number {
  let n = 0;
  for (const h of hunks) {
    if (h.kind !== "conflict") continue;
    if (resolutions[h.index]?.choice) n += 1;
  }
  return n;
}

/**
 * Join the hunk sequence back into a single merged string.
 * Unchanged hunks emit their base lines; external-only / local-only
 * emit the changed side; conflict hunks consult `resolutions`.
 *
 * If a conflict hunk has no resolution yet, this falls back to
 * the local lines so the preview is meaningful even before the
 * user picks. `combine` emits external lines followed by local
 * lines.
 */
export function applyResolutions(
  hunks: ReadonlyArray<MergeHunk>,
  resolutions: Record<number, Resolution>,
): string {
  const out: string[] = [];
  for (const h of hunks) {
    switch (h.kind) {
      case "unchanged":
        out.push(...h.baseLines);
        break;
      case "external-only":
        out.push(...h.externalLines);
        break;
      case "local-only":
        out.push(...h.localLines);
        break;
      case "conflict": {
        const choice = resolutions[h.index]?.choice;
        if (choice === "external") out.push(...h.externalLines);
        else if (choice === "local") out.push(...h.localLines);
        else if (choice === "combine") {
          out.push(...h.externalLines, ...h.localLines);
        } else {
          // Unresolved — surface the local lines as the preview;
          // the host gates "Apply" on full resolution.
          out.push(...h.localLines);
        }
        break;
      }
    }
  }
  return out.join("\n");
}
