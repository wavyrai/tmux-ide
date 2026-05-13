# Goal-21 — LSP-as-tool port audit (G21-P0)

> Mapping the reference LSP layer (`context/opencode/packages/opencode/src/lsp/`)
> to a tmux-ide port. Six files, ~3,450 LOC. The interesting parts are
> _surprisingly small_ once you ignore the long-tail of per-language
> spawn recipes in `server.ts`.

## §1 — Reference LSP architecture

Three layers, three files do the real work:

### 1.1 — `lsp.ts` (~520 LOC) — the high-level Service

A single `Service` object exposes the API every consumer touches:

```ts
interface Interface {
  init():                                Effect<void>
  status():                              Effect<Status[]>
  hasClients(file: string):              Effect<boolean>
  touchFile(file, "document"|"full"?):   Effect<void>
  diagnostics():                         Effect<Record<file, Diagnostic[]>>
  hover({file, line, character}):        Effect<HoverResult>
  definition({file, line, character}):   Effect<Location[]>
  references({file, line, character}):   Effect<Location[]>
  implementation({file, line, character}):Effect<Location[]>
  documentSymbol(uri):                   Effect<(DocumentSymbol|Symbol)[]>
  workspaceSymbol(query):                Effect<Symbol[]>
  prepareCallHierarchy({file,line,char}):Effect<CallHierarchyItem[]>
  incomingCalls({file,line,char}):       Effect<CallHierarchyIncoming[]>
  outgoingCalls({file,line,char}):       Effect<CallHierarchyOutgoing[]>
}
```

State the service owns:

```ts
interface State {
  clients:  LSPClient.Info[]                  // every live client
  servers:  Record<string, LSPServer.Info>    // configured server registry
  broken:   Set<string>                       // "root+serverID" entries that
                                              // failed to spawn — never retried
  spawning: Map<string, Promise<Client|undef>>// in-flight spawns for dedup
}
```

The key trick is **`getClients(file)`**: lazy per-file resolution.

1. Take the file's extension.
2. For every server `s` in the registry: skip if `extensions.length && !extensions.includes(ext)`.
3. Resolve `s.root(file, ctx)` → walks up the directory tree looking for marker
   files (e.g. `package.json` / `pnpm-lock.yaml` / `Cargo.toml`). This is the
   project-root primitive — pure FS, no IPC.
4. Dedup by `(root, serverID)`. If a client already exists → reuse. If a spawn
   is in-flight (the `spawning` map) → await it. Otherwise schedule a new
   spawn.
5. If the spawn fails, mark `root+serverID` broken and never try again this
   session.

Public verbs are thin pipes over `getClients(file)`:

```ts
const hover = (input) => run(input.file, (client) =>
  client.connection.sendRequest("textDocument/hover", {
    textDocument: { uri: pathToFileURL(input.file).href },
    position: { line: input.line, character: input.character },
  }))
```

`workspaceSymbol` is the odd one — fans out across **every** live client (not
just those that match the file), filters by symbol-kind (Class / Function /
Interface / Variable / …) and caps each server's contribution at 10. That's
because workspace symbols are global by definition.

`touchFile(path, "document"|"full"?)` is the "warm me up" verb: opens the file
on every matching client and (optionally) blocks until diagnostics for that
version arrive. This is the bridge between "user opened a buffer" and "agent
asked for diagnostics" — both flows call it.

### 1.2 — `client.ts` (~700 LOC) — the per-server runtime

`create({serverID, server: Handle, root, directory})` wires one
`vscode-jsonrpc` `MessageConnection` over the spawned process's stdio:

```
StreamMessageReader(server.process.stdout) ⇄ MessageConnection ⇄ StreamMessageWriter(server.process.stdin)
```

It owns:

- **`pushDiagnostics: Map<file, Diagnostic[]>`** — populated from
  `textDocument/publishDiagnostics` notifications. The server pushes; we cache.
- **`pullDiagnostics: Map<file, Diagnostic[]>`** — populated from
  `textDocument/diagnostic` / `workspace/diagnostic` request responses. The
  server registers `diagnosticProvider` capability; we pull.
- **`published: Map<file, {at, version}>`** — record-keeping for "have we
  seen a fresh push since `after: <ts>`?" — used by `waitForDiagnostics`.
- **`diagnosticRegistrations: Map<id, CapabilityRegistration>`** — captured
  from `client/registerCapability` requests. Pull-diagnostic identifiers can
  fan-out (tsserver registers multiple).
- **`files: Record<path, {version, text}>`** — incremental document sync
  state. `notify.open(path)` reads from disk, on first call sends `didOpen`;
  on subsequent calls bumps version + sends `didChange` (whole-doc range
  replace for INCREMENTAL syncKind, single text block otherwise).

Important hard-won bits:

- **Initialize handshake is 45 s timeout-bound.** Long enough for tsserver to
  cold-start with type-checking, short enough to fail-fast on a misconfigured
  binary.
- **First-push seeding for tsserver only.** TypeScript pushes aggressively on
  the very first `didOpen`; if we naively wait for a *second* push to count
  as "ready", we wait forever. So we seed the first push as the baseline.
- **`waitForFreshPush` race + `waitForRegistrationChange` race** —
  `waitForDocumentDiagnostics` actually fires the pull request and races it
  against (a) a fresh push for the file at `version`, (b) a server
  re-registering its diagnostic capability (it may have come up mid-flight),
  and (c) a 5s timeout for document mode / 10s for full mode. Whichever
  wins, return.
- **Dedup by `(code, severity, message, source, range)`.** Servers
  occasionally double-publish.

Public surface boils down to:

```ts
{ root, serverID, connection,
  notify: { open(path): Promise<version> },
  get diagnostics(): Map<file, Diagnostic[]>,  // merged push+pull
  waitForDiagnostics(req),
  shutdown() }
```

The raw `connection` is exposed so the high-level service can call arbitrary
`textDocument/*` requests without growing the client surface every time.

### 1.3 — `server.ts` (~2,060 LOC) — per-language spawn recipes

The whole file is one `export const X: Info = {...}` per language server.
`Info` is a small interface:

```ts
interface Info {
  id: string
  extensions: string[]
  global?: boolean
  root: (file, ctx) => Promise<string|undefined>
  spawn(root, ctx): Promise<Handle|undefined>
}

interface Handle {
  process: ChildProcessWithoutNullStreams
  initialization?: Record<string, any>  // server-specific initOptions
}
```

The list (30+ entries): `deno / typescript / vue / eslint / oxlint / biome /
gopls / ruby-lsp / ty / pyright / elixir-ls / zls / csharp / razor / fsharp /
sourcekit-lsp / rust (rust-analyzer) / clangd / svelte / astro / jdtls (java)
/ kotlin-ls / yaml-ls / lua-ls / php intelephense / prisma / dart / ocaml-lsp
/ bash` plus a few more.

Two shared utilities cut the size in half:

- **`NearestRoot(includePatterns, excludePatterns?)`** — the standard "walk
  up from the file looking for `package.json` / `Cargo.toml` / etc." helper.
- **`which(bin)` + `Npm.which("typescript-language-server")`** — locate the
  server binary, falling back to a tracked-in-the-bundle copy when missing.

`spawn()` is allowed to return `undefined` — meaning "we don't have the
binary available, skip this language". The state's `broken` set keeps a
miss from being retried.

Per-server `initialization` is server-specific: e.g. `typescript` passes
`{ tsserver: { path: <absolute path to tsserver.js> } }`. `lua-ls` passes a
big Lua-runtime configuration block. The handle carries it; the client's
`workspace/didChangeConfiguration` notification ships it after the
`initialized` ack.

### 1.4 — `diagnostic.ts` (~30 LOC) — display formatting

Just two functions: `pretty(diag)` formats a single diagnostic for log
output (`ERROR [12:34] missing semicolon`), and `report(file, issues)` wraps
the error subset in `<diagnostics file="...">...</diagnostics>` for chat
agents. Caps at 20 per file, summarises the overflow.

### 1.5 — `language.ts` (~120 LOC) — extension → languageId mapping

Pure data table. Maps `.ts → typescript`, `.tsx → typescriptreact`, etc.
The client uses this to populate the `languageId` field in `didOpen`
notifications. The server registry uses the *extensions* directly when
filtering candidates; the languageId lookup is purely cosmetic for the
LSP wire.

### 1.6 — `launch.ts` (~20 LOC) — Process.spawn wrapper

Thin overload wrapper that forces `stdin/stdout/stderr` to `"pipe"` and
returns a typed `Process.Child`. Nothing tmux-ide-specific — the daemon's
existing `execFile`-based shell-out can serve the same role.

---

## §2 — How "LSP-as-tool" works

The reference codebase ships LSP as **chat-agent tools** so the model can
ask the editor for hover / definition / diagnostics inline. The flow:

```
agent generates tool_use { name: "lsp_diagnostics", input: { file } }
        │
        ▼
chat tool registry resolves "lsp_diagnostics" → handler
        │
        ▼
handler calls Service.touchFile(file, "full")           // open + warm cache
handler calls Service.diagnostics()                     // pull merged map
        │
        ▼
formats result via Diagnostic.report(file, items)       // <diagnostics …>
        │
        ▼
returns to agent as tool_result content
```

Several insights are load-bearing:

1. **Tool calls always go through the same `Service` the editor uses.** No
   parallel "agent-only" path. A hover the user asks for and a hover the
   agent asks for hit the same `getClients` cache, the same opened-document
   table, the same diagnostic stream.
2. **The agent doesn't pick a language server.** It names a *file*; the
   service routes the request to whichever client(s) match the file
   extension + project root. This is critical for monorepos where the same
   path may have TypeScript + ESLint clients running concurrently — both
   get the request, results merge.
3. **`touchFile(path, "full")` is the agent's friend.** Without it, asking
   for diagnostics on a file the user never opened returns `{}` (the cache
   is per-document). The handler opens the document on every matching
   client, then awaits up to 10s for fresh diagnostics before sampling the
   merged map.
4. **Outputs are heavily formatted for token-economy.** `Diagnostic.report`
   limits to errors (severity 1), caps at 20 per file, wraps in an XML-ish
   tag the agent recognizes. Hover responses are passed through verbatim
   because they're already compact.
5. **Tools degrade gracefully.** Each handler in `lsp.ts` uses
   `.catch(() => null)` / `.catch(() => [])` so a misbehaving server can't
   surface a stack-trace into the chat. The agent sees an empty list and
   moves on.

The "tool surface" is therefore tiny — five-ish tools all of which call into
the same Service:

| Tool | Service call | Returns |
|---|---|---|
| `lsp.diagnostics` | `touchFile + diagnostics` | error list per file (XML-wrapped) |
| `lsp.hover` | `hover` | markdown hover content |
| `lsp.definitions` | `definition` | `Location[]` (uri+range) |
| `lsp.references` | `references` | `Location[]` |
| `lsp.symbols` | `documentSymbol` / `workspaceSymbol` | `Symbol[]` |

That's the whole MVP.

---

## §3 — What we already have / need / explicitly don't need

### Already in tmux-ide

- `child_process.execFile`-style shell-out infra (used by `git-service.ts`,
  `terminal-bridge`).
- Workspace-aware project-root detection (`session.dir`).
- Effect-backed daemon service pattern (`packages/daemon/src/git/*` is the
  template).
- Action / REST dispatch surface for chat tools
  (`packages/daemon/src/command-center/server.ts` + the
  `chat.thread.*` precedent).
- `terminals.json`-style atomic-write registry for per-session metadata if
  we need to persist anything.
- The WS broadcast channel (`/ws/events`) with frame-schema discipline —
  we can emit `lsp.diagnostics.changed` on push without inventing a new
  transport.
- Workspace-aware `discoverSessions()` for the daemon-side `cwd` resolution.

### What we need to add

1. **`vscode-jsonrpc` + `vscode-languageserver-types` dependencies** in
   `packages/daemon`. Total ~200 KB. No native deps.
2. **`packages/daemon/src/lsp/` directory** mirroring the reference layout —
   `client.ts / lsp.ts / server.ts / language.ts / launch.ts / diagnostic.ts`.
   Total target: ~2,000 LOC (we can drop several language-server recipes
   for P1).
3. **REST + WS surface:**
   - `GET  /api/project/:name/lsp/status` — per-server connected/error state.
   - `POST /api/project/:name/lsp/touch` — `{path, mode?}` — opens the
     buffer on every matching client.
   - `GET  /api/project/:name/lsp/diagnostics` — merged map.
   - `POST /api/project/:name/lsp/hover` — `{file, line, character}` → hover.
   - `POST /api/project/:name/lsp/definition` — same shape → `Location[]`.
   - `POST /api/project/:name/lsp/references` — same shape.
   - `POST /api/project/:name/lsp/symbols/document` — `{uri}` → document symbols.
   - `POST /api/project/:name/lsp/symbols/workspace` — `{query}` → workspace symbols.
   - WS frame `lsp.diagnostics.changed` with `{sessionName, path, serverID}`
     emitted on push for the editor's gutter / problems panel.
4. **Chat tool registry entries** in
   `packages/daemon/src/chat/tools/` (`lsp-hover.ts`, `lsp-diagnostics.ts`,
   `lsp-definitions.ts`, `lsp-symbols.ts`). Each is a 30-line zod-validated
   wrapper that calls the daemon's LSP service. The output is pre-formatted
   for token economy (same `Diagnostic.report` pattern).
5. **Dashboard-side `lib/lsp/` Effect client** matching the `lib/git/`
   shape: `fetchDiagnostics / hover / definition / useLspStatus` plus a
   Solid resource for per-file diagnostics keyed on `(session, path)` so
   the editor can react.
6. **One reference language server in P1: `typescript-language-server`** —
   the heaviest path with the loudest behaviour (pull + push diagnostics,
   workspace symbols, multiple identifiers). If we get that right, the
   others are straight-line ports.

### What we explicitly DON'T need

- The full 30-server `server.ts` catalogue. Each shipped language is
  scope-creep until we know which ones users care about. P1 ships
  `typescript-language-server`; P4 lands a curated short list
  (`gopls`, `pyright`, `rust-analyzer`, `clangd`).
- A custom JSON-RPC transport. `vscode-jsonrpc` over stdio is the LSP
  baseline; there's no reason to invent.
- An on-disk diagnostics cache. The whole point of LSP is the server holds
  its state — we restart cold and let it re-warm. The daemon's in-memory
  `clients` map plus the existing reconnect path on file open is enough.
- A separate "language registry" service. The `LANGUAGE_EXTENSIONS` table
  is a pure data port; we drop it into the Effect service alongside the
  servers registry.

---

## §4 — Solid port targets

| Reference | Port target | Notes |
|---|---|---|
| `src/lsp/launch.ts` | `packages/daemon/src/lsp/launch.ts` | 20 LOC — drop the `Process` wrapper; use `child_process.spawn` directly. |
| `src/lsp/language.ts` | `packages/daemon/src/lsp/language.ts` | Pure data — copy verbatim. |
| `src/lsp/diagnostic.ts` | `packages/daemon/src/lsp/diagnostic.ts` | Pure — copy. |
| `src/lsp/server.ts` (per-server `Info` records) | `packages/daemon/src/lsp/servers/{typescript,gopls,pyright,…}.ts` | Each language gets its own file. P1 ships `typescript.ts` only. |
| `src/lsp/client.ts` | `packages/daemon/src/lsp/client.ts` | The 700-line port. Same `vscode-jsonrpc` wiring, same diagnostic state machine, same `notify.open` document-sync. Drop the `BusEvent` + `Filesystem.normalizePath` indirection — use Node `node:fs/promises` + our existing event-emitter pattern. |
| `src/lsp/lsp.ts` (Service) | `packages/daemon/src/lsp/lsp-service.ts` | The orchestrator. Effect-backed (matches our git-service pattern). Replace MobX `runInAction` analogues with direct map mutations under a per-session mutex. The `getClients(file)` algorithm ports unchanged. |
| Server tool registry | `packages/daemon/src/chat/tools/lsp-*.ts` | Five new tools (hover / diagnostics / definitions / references / symbols). Each wraps a single Service call + result formatter. |
| Renderer side (no analogue yet) | `dashboard/src/lib/lsp/` + `dashboard/src/components/Editor/*` | Solid resource for diagnostics keyed on `(session, path)` + a Solid component for inline gutter markers. The editor's hover tooltip already has a slot via pane 1's Monaco port — we just feed it from the new Service. |

The renderer-side editor surface is *carefully out of scope* for this audit's
port plan — pane 1's Goal-17 owns Monaco wiring + editor hover/gutter slots.
G21 supplies the data; G17 supplies the UI hooks. The G21 work below
**must not touch `dashboard/src/lib/editor/` or `dashboard/src/lib/monaco/`**.

---

## §5 — Five phases

### G21-P1 — Daemon LSP service + TypeScript reference (~3 days)

Scope: every piece of the daemon-side LSP infrastructure, exercised
end-to-end against `typescript-language-server`.

Files:

- `packages/daemon/src/lsp/launch.ts` — spawn wrapper.
- `packages/daemon/src/lsp/language.ts` — extension table.
- `packages/daemon/src/lsp/diagnostic.ts` — pretty + report.
- `packages/daemon/src/lsp/client.ts` — vscode-jsonrpc client +
  push/pull diagnostic state machine + `notify.open` document sync.
- `packages/daemon/src/lsp/servers/typescript.ts` — the one `Info`.
- `packages/daemon/src/lsp/lsp-service.ts` — the `Service` shape +
  `getClients` algorithm + every public verb.
- `packages/daemon/src/command-center/server.ts` — 7 new REST routes
  (status / touch / diagnostics / hover / definition / references /
  documentSymbol).
- WS frame `lsp.diagnostics.changed` schema + emission on every
  `pushDiagnostics` update.
- 25+ unit tests against synthetic `MessageConnection`s for the client
  state machine; smoke tests for the service.

Acceptance:

- `POST /api/project/:name/lsp/touch` on a real TS file opens
  `typescript-language-server`, sends `initialize` + `didOpen`,
  receives diagnostics, populates the merged map.
- `POST /api/project/:name/lsp/hover` on a known identifier returns
  non-null content.
- Two concurrent `touch` calls on different files within the same
  project share one server process.
- `tmux-ide restart` cleanly shuts down all spawned LSP processes.

**Effort:** ~24 hours.

### G21-P2 — Chat-tool surface for agents (~1 day)

Scope: register LSP tools in the daemon's chat-tool registry so the
agent can call them.

Files:

- `packages/daemon/src/chat/tools/lsp-diagnostics.ts` — `{file?, scope?}`
  → `<diagnostics …>` text block. With no args, returns *all known*
  diagnostics — matches the existing "what's broken" tool ergonomics.
- `packages/daemon/src/chat/tools/lsp-hover.ts` — `{file, line, character}`
  → hover markdown.
- `packages/daemon/src/chat/tools/lsp-definitions.ts` — `{file, line,
  character}` → relative paths + line ranges. Resolved via `references`
  when definition is empty (some servers conflate the two).
- `packages/daemon/src/chat/tools/lsp-symbols.ts` — `{query}` → list of
  symbols across the workspace.
- Tool registration via the existing `provider-registry` plumbing.
- 10+ tests verifying the wire (tool input → service call → formatted output).

Acceptance:

- Agent can ask for diagnostics on an unopened file and get useful output.
- Token cost: a 100-error file produces a ≤ 2 KB tool result (capped at 20
  errors, ellipsised).
- A tool call against a file with no matching server returns an empty
  string, not an error.

**Effort:** ~8 hours.

### G21-P3 — IDE-side editor surface (~2 days)

Scope: the dashboard's editor view consumes the LSP service.

Files:

- `dashboard/src/lib/lsp/index.ts` — Effect-wrapped fetchers + Solid
  resources matching the `lib/git/` shape.
- `dashboard/src/lib/lsp/useDiagnostics.ts` — Solid resource keyed on
  `(session, path)` with WS subscription to `lsp.diagnostics.changed`.
- `dashboard/src/components/Diagnostics/Gutter.tsx` — pure render of
  Diagnostic[] as gutter markers. Consumed by the editor surface
  pane 1 (G17) ships.
- `dashboard/src/components/Diagnostics/HoverCard.tsx` — Solid floating
  panel triggered by an editor-side hover event. Slots into pane 1's
  hover provider.

`dashboard/src/lib/editor/` and `dashboard/src/lib/monaco/` stay
**read-only from G21**. The new modules export to those folders' API
contracts but don't modify them.

Acceptance:

- Inline red squiggles under errors when the user edits a TS file.
- Cmd-click on an identifier navigates to its definition (via pane 1's
  editor go-to-def hook, fed by `lsp.definition`).
- Hover delay matches VS Code (~300 ms after pointer stop).

**Effort:** ~16 hours.

### G21-P4 — Multi-language servers (~2 days)

Scope: a curated short list of language-server `Info` files.

Files:

- `packages/daemon/src/lsp/servers/gopls.ts` — `gopls` (Go).
- `packages/daemon/src/lsp/servers/pyright.ts` — `pyright`-langserver (Python).
- `packages/daemon/src/lsp/servers/rust.ts` — `rust-analyzer` (Rust).
- `packages/daemon/src/lsp/servers/clangd.ts` — `clangd` (C / C++).
- Per-language smoke tests + a config knob (`ide.yml → lsp.disabled[]`)
  to opt out of any of them.

Acceptance:

- Opening `main.go` / `main.py` / `main.rs` / `main.cpp` produces
  diagnostics from the matching server.
- Each server's `spawn()` returns `undefined` when the binary is missing,
  the service's `broken` set keeps subsequent calls from retrying.
- Configurable per-session: `ide.yml`'s new `lsp.disabled: [gopls]`
  prevents `gopls` from spawning even when `go` files are present.

**Effort:** ~16 hours.

### G21-P5 — Polish (~1.5 days)

Scope: the long-tail verbs and config UI.

Files / surfaces:

- `lsp.workspaceSymbol` + a palette result group (Cmd-T-style symbol
  search across the project, fan-out across servers, top-K = 50).
- `lsp.rename` — `{file, line, character, newName}` → workspace-wide
  edits applied through the daemon's existing diff machinery.
- `lsp.codeActions` — `{file, range}` → list of quick-fix titles +
  apply-by-id endpoint.
- Call hierarchy verbs (`prepareCallHierarchy / incoming / outgoing`)
  exposed as REST + Solid hooks.
- `LSP` row in `/v2/settings`: per-server enable / disable, log-level
  knob, "Restart all" button. Reuses the existing settings store +
  daemon config write path.

**Effort:** ~12 hours.

### Totals

| Phase | Scope | Effort |
| --- | --- | --- |
| G21-P1 | Daemon LSP service + TypeScript reference | ~24 h |
| G21-P2 | Chat tools | ~8 h |
| G21-P3 | IDE-side editor surface | ~16 h |
| G21-P4 | Multi-language servers | ~16 h |
| G21-P5 | Polish (rename / code actions / workspace symbols UI) | ~12 h |
| **Total** | | **~76 h (~9–10 person-days)** |

---

## §6 — Open questions

1. **Per-session vs per-workspace clients.** Reference uses `(root,
   serverID)` as the dedup key — multiple sessions opening the same repo
   share clients. We probably want per-session for now (matches
   `terminals.json` discipline), but the data structure can flip without
   user-visible changes. Decide at P1.
2. **Where does the binary live?** Reference relies on
   `Module.resolve("typescript-language-server")` and a tracked-in-bundle
   fallback. We can either (a) require users to install
   `typescript-language-server` via `npm i -g`, (b) ship it under
   `packages/daemon/vendor/` (bundle bloat), or (c) auto-`npm install`
   on first use into `~/.tmux-ide/lsp/`. Recommend (c) — opt-in,
   non-blocking, transparent. Decide at P1.
3. **Diagnostic backpressure.** A user editing fast generates a
   diagnostic burst per keystroke. The reference debounces at 150 ms in
   the client. For the WS push we should additionally coalesce — burst
   N pushes for the same path within 200 ms into one `lsp.diagnostics.changed`
   frame on the dashboard side. Decide at P3.
4. **Tool-output token budget.** `Diagnostic.report` caps at 20 errors
   per file; should `lsp.hover` cap at e.g. 4 KB markdown? Some servers
   return entire docstrings. Probably yes — pin in P2.
5. **Initialize timeout.** Reference uses 45 s. Cold tsserver on a big
   monorepo can flirt with that. Bump to 60 s + emit a progress frame
   so the UI can surface "still booting"? Probably yes. Decide at P1.

---

## TL;DR

The reference LSP layer is roughly **two services + a per-language
registry**. Most of the volume is `server.ts`'s 30-server spawn list,
which is a long-tail port that can land one language at a time.

**G21-P1 is the load-bearing slice.** It ports `client.ts` (the 700-line
diagnostic state machine), `lsp.ts` (the per-file router + Service), and
*one* language (`typescript`). Everything else hangs off it:

- **P2** wraps the Service in tool registrations — five 30-line files.
- **P3** wraps the Service in REST + Solid resources for the editor.
- **P4** adds more `server.ts` entries.
- **P5** adds rename / code-actions / workspace-symbols polish.

The biggest leverage: **landing `client.ts` + `lsp-service.ts` cleanly
in P1 sets up every downstream surface for a same-day port.** The
existing `git-service.ts` Effect pattern + `terminals-store.ts` JSON
registry are direct templates — no new infra invention required.
