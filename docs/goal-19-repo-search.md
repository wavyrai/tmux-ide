# Goal-19 — Repo search (ripgrep + Cmd-Shift-F panel)

> **Status:** Design proposal. No code changes. **Important caveat:** the reference codebase audited for prior goals does NOT ship a ripgrep-backed repo-search panel — every "search" surface in it is either terminal scrollback (audited in G20-P0), an issue-provider lookup (GitHub/Jira/Linear external APIs), or Monaco's built-in in-file find. This goal is therefore a _design from first principles_, informed by adjacent reference patterns (issue-search wire shapes, panel UX, Monaco find dialog) plus ripgrep's well-known operational best practices.
> **Motivation:** the v2 shell currently has a file-tree but no way to grep across the workspace. Cmd-Shift-F find-in-files is table-stakes for a code editor — bigger UX gap than the editor itself was before G17.

---

## §1 — Daemon endpoint shape

Recommend a streaming endpoint, not a single big JSON blob:

```
GET /api/project/:name/search
  ?q=<query>
  &include=<glob,glob,...>     // forwarded as --glob args
  &exclude=<glob,glob,...>     // forwarded as --glob !args
  &case=insensitive|smart|sensitive   // default: smart
  &regex=true|false             // false = literal (rg -F)
  &context=<n>                  // lines of context (rg -C n), default 0
  &maxResults=<n>               // default 1000, hard cap 10000
  &maxFileSize=<bytes>          // default 5_000_000 (skip files >5 MB)
```

**Response: NDJSON event stream** (`Content-Type: application/x-ndjson`). Each line is one of:

```jsonc
{ "type": "begin",   "path": "src/foo.ts" }
{ "type": "match",   "path": "src/foo.ts", "line": 42, "text": "  TODO: refactor\n",
  "submatches": [{ "start": 2, "end": 6 }],
  "context": { "before": ["// existing comment"], "after": [] } }
{ "type": "end",     "path": "src/foo.ts" }
{ "type": "summary", "matches": 12, "filesSearched": 1834, "elapsedMs": 47,
  "truncated": false }
{ "type": "error",   "message": "regex syntax error: ...", "fatal": true }
```

NDJSON over a JSON array means the UI can render the first hit before ripgrep finishes the last file. Each `match` line is one logical hit (line-level), pre-shaped for the UI to render without remapping. `submatches[]` carries per-match column ranges (rg can emit multiple matches per line).

**Why NDJSON over WebSocket?** A SearchService inside `dashboard/src/lib/search/` opens one fetch per query; cancellation = `AbortController.abort()`. WebSockets would buy us nothing here (no client → server messages after the initial request), and the daemon already proves the NDJSON pattern works (the build-log SSE endpoint uses the same shape).

**Path sandboxing.** Reuse the existing pattern from `/api/project/:name/preview/:file{.+}` (server.ts:1589-1635): resolve via `realpathSync`, reject anything that escapes `session.dir`. Forward the search root to ripgrep as the _only_ path argument so a malicious `include` glob can't break out.

**Cancellation.** When the HTTP request closes (client `AbortController.abort()` or page unload), kill the ripgrep child via `child.kill('SIGTERM')`. ripgrep handles SIGTERM cleanly and exits within ~5ms.

**Auth.** Same gate as the rest of `/api/project/:name/*` — local-bypass token + bearer header. No new auth surface.

**Sibling action.** Optional thin POST `POST /api/v2/action/search.replace` for the apply-replace flow (see §4). Lives next to the streaming GET, doesn't need streaming.

---

## §2 — ripgrep invocation strategy

```bash
rg --json \
   --max-count 50 \
   --max-filesize 5M \
   --hidden \
   --no-ignore-vcs=false \
   --smart-case \
   --no-messages \
   --color=never \
   --threads $(nproc) \
   [--regexp <q> | --fixed-strings <q>] \
   [--glob <include>...] \
   [--glob '!<exclude>'...] \
   [--context <n>] \
   -- "$SESSION_DIR"
```

**Flags worth pinning:**

| Flag                            | Why                                                                                                                                                                                                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--json`                        | Line-delimited JSON output. The whole strategy hinges on this — see §1 schema.                                                                                                                                                                                   |
| `--max-count 50`                | Cap _per file_. Without it, a `console.log` in node_modules dwarfs everything. The UI's `maxResults` query param maps onto this (rg `--max-count` is per-file; total cap is enforced by the daemon counting `match` events and killing the child once exceeded). |
| `--max-filesize 5M`             | Skip generated lockfiles, bundles, build artifacts. Configurable via query param.                                                                                                                                                                                |
| `--hidden`                      | Include dotfiles (`.github/`, `.env.example`). Users expect them in repo search.                                                                                                                                                                                 |
| `--no-ignore-vcs=false`         | Respect `.gitignore` (and `.ignore`, `.rgignore`). This is the _default_, listing it for clarity.                                                                                                                                                                |
| `--smart-case`                  | Mixed-case query → case-sensitive; all-lowercase → case-insensitive. Mirrors common editor conventions. The `case=` query param overrides to `--case-sensitive` or `--ignore-case`.                                                                              |
| `--no-messages`                 | Suppress "permission denied" noise from unreadable files; the user doesn't need to see them.                                                                                                                                                                     |
| `--color=never`                 | We don't render ANSI — `--json` already gives us submatch ranges.                                                                                                                                                                                                |
| `--threads $(nproc)`            | ripgrep parallelizes by file automatically; explicit thread count keeps it predictable across deployments.                                                                                                                                                       |
| `--regexp` vs `--fixed-strings` | Toggled by the `regex=` query param. Default is literal-string search (faster + safer; users who want regex tick the box).                                                                                                                                       |
| `--glob`                        | Forward `include` query as positive globs, `exclude` as `!` prefixed. ripgrep applies them additively on top of `.gitignore`.                                                                                                                                    |

**Parsing strategy.** The daemon spawns rg with `stdio: ['ignore', 'pipe', 'pipe']`, attaches a line-buffered reader to stdout, and forwards each line to the NDJSON response with minimal re-shaping:

```ts
// Pseudo-code shape
const child = spawn(rg, args, { cwd: session.dir, stdio: ["ignore", "pipe", "pipe"] });
const rl = readline.createInterface({ input: child.stdout });
let matchCount = 0;
for await (const line of rl) {
  const frame = JSON.parse(line) as RgFrame;
  if (frame.type === "match") {
    matchCount += 1;
    if (matchCount > maxResults) {
      child.kill("SIGTERM");
      yield JSON.stringify({ type: "summary", matches: matchCount, truncated: true }) + "\n";
      return;
    }
  }
  yield reshape(frame) + "\n";
}
```

ripgrep's `--json` schema is stable (their CLI docs commit to it). We translate field names to match the UI shape (`lines.text` → `text`, `submatches[].match.text` drop redundant text) but the structure is 1:1.

**Stderr handling.** A non-zero exit code with `--json` usually means regex syntax error or path doesn't exist. Drain stderr into a single `{type:'error', fatal:true}` frame and close the response. No fallback to text mode — ambiguity isn't worth the rescue.

**Cold-start performance.** Without any caching ripgrep parses `.gitignore` per invocation; for monorepos this adds 20–80 ms. Recommend: don't cache. Search queries are usually distinct enough that a parsed-ignore cache would be churn for negligible win.

**`rg` binary discovery.** Three-tier resolution:

1. `process.env.TMUX_IDE_RIPGREP_PATH` (test escape hatch).
2. Look on `$PATH` via `which('rg')`.
3. Fall back to the `@vscode/ripgrep` bundled binary (~5 MB extra dep — add it so cross-platform installs always work even without system rg).

Recommend bundling `@vscode/ripgrep` so the feature works out-of-the-box on Windows + Linux installs that don't ship `rg`. On macOS dev machines `which rg` usually wins (Homebrew).

---

## §3 — Solid Cmd-Shift-F panel

**Mount point.** New activity-bar entry `'search'` next to `'explorer'` in `dashboard/src/components/ActivityBar.tsx`. Cmd-Shift-F (Mac) / Ctrl-Shift-F (Linux) toggles it; clicking the activity icon also toggles. Same width as the file tree (resizable, default 320 px).

**Layout:**

```
┌─ Search ────────────────────────────────┐
│ ┌─────────────────────────────────────┐ │  (1) Query input
│ │ TODO|                              ⓧ │ │
│ └─────────────────────────────────────┘ │
│ ┌─────────────────────────────────────┐ │  (2) Replace input (collapsible)
│ │ [replace with…]                ↻    │ │
│ └─────────────────────────────────────┘ │
│ [Aa] [.*] [Ww]                          │  (3) Toggles: case / regex / word
│ ▾ files to include                      │  (4) Filters (collapsed by default)
│   [src/**/*.ts                       ]  │
│ ▾ files to exclude                      │
│   [**/*.test.ts, node_modules/**     ]  │
│                                         │
│ 42 results in 7 files (·47ms)           │  (5) Summary
│                                         │
│ ▾ src/foo.ts        (5 matches)         │  (6) Grouped results
│   12  // TODO: refactor this            │
│   23     TODO: split into ...           │
│   ...                                   │
│ ▾ src/bar.ts        (3 matches)         │
│   ...                                   │
└─────────────────────────────────────────┘
```

**State (Solid signals + Effect.Service).**

```ts
// dashboard/src/lib/search/searchService.ts
export interface SearchService {
  readonly query: Signal<string>;
  readonly replaceWith: Signal<string>;
  readonly options: Signal<SearchOptions>; // {caseMode, regex, word, include, exclude}
  readonly results: Store<{
    byFile: Record<string, FileMatch>; // path → FileMatch
    summary: { matches; filesSearched; elapsedMs; truncated };
    status: "idle" | "running" | "done" | "error" | "cancelled";
    error?: string;
  }>;
  readonly run: (q: string) => Effect.Effect<void, SearchError>;
  readonly cancel: () => void;
  readonly replace: (target: ReplaceTarget) => Effect.Effect<ReplaceResult, ReplaceError>;
}
```

`FileMatch` carries the per-file list of `{line, text, submatches, before, after}`. `Store` (Solid `createStore`) drives the result list reactively; the panel reads `results.byFile` and a per-file `expanded` flag in a sibling signal.

**Behavior:**

- Input debounce: 200 ms on the query signal; firing a search cancels any in-flight `AbortController`.
- Streaming render: each `match` event appends to `results.byFile[path]` reactively, so users see hits accumulate. First-paint cost is one match.
- File groups collapse to header on click; default state is expanded for the first 3 files, collapsed for the rest (avoids drowning the user).
- Each match row shows line number left-aligned, line text middle (with the matched range highlighted via `<mark>`-style span using `submatches`), and a click handler that calls the existing `onOpenFile({ path, line, column })` host callback (already wired through `chat-solid` and the file tree).
- Empty query → no search fired, status `idle`. Empty result → "No matches" placeholder; ripgrep error → red banner with the error text.
- "Truncated" badge when summary says so (matches > maxResults); offer a "show all" button that re-runs without the cap.

**Keybinds (inside the panel):**

- `Enter` in query → focus first match.
- `Cmd-Enter` in query → open replace input.
- `↑/↓` in results → navigate matches (skip across file groups).
- `Cmd-G` → next match; `Cmd-Shift-G` → prev match.
- `Esc` → clear query and return focus to query input; second `Esc` closes the panel.

**Reuse.** Use the existing dashboard primitives (`<Input>`, `<Button>`, `<Tooltip>`) and the keybind registration pattern from chat-solid's command palette. Don't bring in a new component library.

---

## §4 — Replace flow

Three modes, escalating in scope and confirmation weight:

### 4.1 — Replace one match

Inline action on a match row: hover reveals a small "replace" button (or right-click menu). Click → daemon writes the file with that single match replaced via the file-write action (`PUT /api/project/:name/file/:file{.+}` from the Goal-17 editor port). The daemon reads the file, performs an in-memory substring replace at the _exact byte offset_ from rg's `absolute_offset`, and writes back. **No diff dialog** — single-line replace is reversible via the file's own undo if it's open in the editor.

### 4.2 — Replace all in file

Per-file group action. Same flow as 4.1 but applies all matches in that file in a single write. Confirmation: an inline "Replace 5 matches in `src/foo.ts`?" with [Replace] / [Cancel] inline (no modal — the file group already has the visual context).

### 4.3 — Replace across files

The big one. Top-of-panel "Replace all" button (disabled until both query + replace inputs are non-empty). Click opens a **preview modal**:

```
Replace 42 matches across 7 files

  src/foo.ts          5 matches
  src/bar.ts          3 matches
  ...

  Preview: src/foo.ts:12
  - // TODO: refactor this
  + // FIXED: refactor this

[ Cancel ]                          [ Replace 42 in 7 files ]
```

Modal shows the file list + a per-file diff preview that the user can step through with ↑/↓. Each file's preview is computed client-side from the current `FileMatch` data (no extra daemon round-trip). The "Replace 42 in 7 files" button is disabled until the user has either scrolled through every file's preview OR clicked an "I trust the preview, skip" affordance.

**Daemon endpoint:** `POST /api/v2/action/search.replace`

```jsonc
// Input:
{ "session": "tmux-ide",
  "query": "TODO",
  "replacement": "FIXED",
  "regex": false,
  "caseMode": "smart",
  "files": [
    { "path": "src/foo.ts", "matches": [
        { "line": 12, "offset": 142, "length": 4 },
        { "line": 23, "offset": 287, "length": 4 }
    ] }
    // ... omitted for brevity
  ],
  "expectedTotalMatches": 42
}

// Result:
{ "filesUpdated": 7,
  "matchesReplaced": 42,
  "skipped": [{ "path": "src/baz.ts", "reason": "file_modified_since_search" }]
}
```

**Safety rails:**

- Each file is read fresh by the daemon, hashed, compared against an `expectedMtime` from the search snapshot. If the file changed since the search ran, skip it and report in `skipped[]`. The UI re-shows a "some files were modified — re-run search" prompt.
- Replacements are applied by offset (not by re-running the regex). This eliminates the "match the regex differently in a slightly different context" failure mode and keeps the daemon dumb.
- Daemon writes via atomic temp-file + rename (the existing `writeFileSync` pattern in server.ts).
- The action is NOT transactional across files — partial failure is possible. Report per-file outcomes; the UI shows red badges next to skipped/failed files.
- No undo. The user is expected to commit before mass-replace; if they don't, `git checkout -- .` is the recovery path. **Make this clear in the confirmation modal copy.**

**Regex captures.** When `regex=true`, the replacement supports `$1`/`$2` capture groups. Daemon-side this means we _do_ need to re-run the regex per match site (offset-only replacement doesn't carry capture data). Acceptable cost for the regex case — most replace operations are literal.

---

## §5 — Integration with the existing Explorer/Files widget

Three touchpoints:

### 5.1 — Activity bar entry

New `'search'` activity-bar icon (lucide `Search`) between `'explorer'` and the next entry. Shares the same active-state styling as the rest of the bar. The keybind (`Cmd-Shift-F`) opens the panel AND focuses the query input, even if the user is in a different panel.

### 5.2 — Right-click on file/folder in Explorer → "Search in folder"

A `Files` widget context menu item that pre-fills the search panel's `include` with the clicked path's glob (`src/foo/**` for a directory; the file's basename pattern for a file). This is the highest-leverage integration — most "I want to grep" moments start with knowing the rough area.

Wire via the existing Files widget right-click menu pattern. ~20 LOC addition to the Files widget; no new infra.

### 5.3 — Open file → seek to line/column from search result

Click a match row → call `onOpenFile({ path, line, column })`. The Goal-17 editor port already plans this callback as the canonical "open at location" handle (see `goal-17-code-editor.md` §3 — `onOpenFile?: (meta: MarkdownFileLinkMeta) => void`). Search results reuse the same surface — when G17 lands the click goes to the Monaco editor with a cursor placed at `(line, column)`; until then it falls back to the existing `/v2/preview/:file` route.

### 5.4 — (Optional polish) Search-in-current-file

If the active editor has a focused Monaco instance and the user hits `Cmd-F`, that's Monaco's built-in find — leave it alone. If they hit `Cmd-Shift-F`, that's repo search; pre-fill nothing.

---

## §6 — Phased plan

| Phase      | Scope                                                                                                                                                                                                                      | Effort                     |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| **G19-P1** | Daemon endpoint: `GET /api/project/:name/search` with NDJSON streaming, ripgrep binary discovery, sandboxed search root, cancellation on client close. Plus a SearchService unit-test suite that pins the response schema. | ~10 h                      |
| **G19-P2** | Solid panel: activity bar entry, query input, results grouped by file, click → open file. Streaming render via Solid `createStore`. Cmd-Shift-F keybind. No replace yet.                                                   | ~12 h                      |
| **G19-P3** | Replace flow: inline single-match replace, per-file replace, modal-confirmed across-files replace. Daemon-side `search.replace` action with offset-based writes + mtime guard.                                             | ~12 h                      |
| **G19-P4** | Explorer integration: right-click "Search in folder" + open-at-line wiring to the Goal-17 editor (or fallback to preview). Polish: result counters, truncation banner, "show all" escape hatch.                            | ~6 h                       |
| **Total**  |                                                                                                                                                                                                                            | **~40 h (~5 person-days)** |

---

## §7 — Open questions

1. **Bundle `@vscode/ripgrep`?** Yes. ~5 MB binary, cross-platform, one less env dep. The daemon already ships native binaries (`better-sqlite3`, `node-pty`); ripgrep is consistent with that posture.
2. **Index-backed search (sqlite FTS or similar) for huge monorepos?** Not for G19. ripgrep can grep 10 GB in 2–3 seconds; that's plenty fast for the dev-tool target. Revisit only if a user reports a project where rg takes >10 s per query.
3. **Search history?** Defer. Solid `createSignal` + localStorage is a 30-line addition once the panel ships.
4. **Saved searches?** Defer. Premature feature until the basic flow ships.
5. **Search inside binary files?** No. ripgrep's `--binary` flag exists but the UX value is near-zero. Skip.
6. **Search inside git history (`git log -S`)?** Out of scope for G19. Could be a separate goal once G18 lands the git client.
7. **Multi-line patterns?** ripgrep supports `--multiline`; opt-in via a panel toggle. Recommend P4 polish, not P2.
8. **Highlight in editor on open?** When clicking a match, ideally the editor opens with the match range highlighted (not just the cursor positioned at `(line, column)`). The Monaco port's `editor.setSelection({startLineNumber, startColumn, endLineNumber, endColumn})` makes this trivial — wire as P4 polish.
9. **Replace preview generation — client or daemon?** Recommendation: **client.** The data is already in the panel's `FileMatch` store; rebuilding it server-side would just be wasted round-trips. Daemon does the actual write only.
10. **Honor `.tmux-ideignore` or just `.gitignore`?** Just `.gitignore` for now. ripgrep also honors `.ignore` and `.rgignore` by default — power users can drop one of those into their repo if they want different rules.

---

## TL;DR

The reference codebase audited for prior goals does NOT ship a ripgrep-backed search panel — every "search" surface in it is terminal scrollback (G20), issue-provider lookup (external APIs), or Monaco's built-in in-file find. **This goal is a design from first principles**, informed by adjacent reference patterns + ripgrep's stable `--json` schema. ~5 person-days total.

**Recommended architecture in three lines:**

1. **Daemon:** `GET /api/project/:name/search` streams NDJSON one match per line; ripgrep `--json` is the parser-source-of-truth; cancel = AbortController + SIGTERM.
2. **Renderer:** Solid panel mounted via a new `'search'` activity-bar entry; Cmd-Shift-F toggles; results stream into a `createStore` grouped by file; click → existing `onOpenFile` callback.
3. **Replace:** offset-based daemon writes with mtime guards; client-side preview; modal confirmation only for across-files replace.

**Top three hardest things to get right:**

1. **The NDJSON stream contract.** Once the panel renders streaming hits, the response schema becomes a public-ish API surface — any churn requires both daemon + UI redeploy. Pin it in a contracts test before P2 lands.
2. **Replace mtime guard.** The "file modified since search" race is real and silent if we don't check. Hash + mtime comparison per file is the standard mitigation but easy to forget for a "single match" replace.
3. **Bundling `@vscode/ripgrep` cross-platform.** The package ships per-platform binaries via `postinstall`; making sure the dashboard build picks the right one for the user's machine takes care (it's why most apps ship the system `rg` binary instead). Budget 2 hours of CI / packaging time in P1.

The single biggest leverage point: **ripgrep does all the hard work**. The daemon is a thin streaming adapter; the renderer is a list with filters; the replace flow is offset-based file writes. No fancy indexing, no LSP, no fuzzy matching layer — just stream the matches and let users click.
