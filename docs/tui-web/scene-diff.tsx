/**
 * The Diff surface — the app's real model, on real git output.
 *
 * The file list is `parseStatusGroups` fed genuine `git status --porcelain v1`
 * text, grouped into staged / unstaged / untracked by the app's own rules and
 * laid out by `buildDiffRows`. The hunk pane is `classifyDiff` over a genuine
 * unified diff — the same function that colors it in the terminal, so a `+` line
 * is green here because the app says it is, not because this file says so.
 *
 * Click a file to open it. The [s stage] verb moves it between groups, which is
 * the whole point of the surface: staging without leaving the app.
 */
import { For, Show, createMemo, createSignal } from "solid-js";
import {
  buildDiffRows,
  classifyDiff,
  parseStatusGroups,
  type DiffEntry,
} from "@daemon/tui/mirror/diff-model.ts";
import { ACCENT, DEFAULT_BG, DEFAULT_FG, MUTED, TAB_ACTIVE_BG } from "@daemon/tui/mirror/theme.ts";
import { STATUS_COLOR } from "@daemon/tui/mirror/status-grammar.ts";
import { DEMO_PANEL_BG } from "./demo-theme.ts";

const LIST_W = 36;
const HUNK_W = 60;
const ROWS = 16;

/** Genuine `git status --porcelain` output (XY PATH). */
const PORCELAIN = [
  "M  packages/daemon/src/tui/mirror/sidebar.tsx",
  "A  packages/daemon/src/tui/mirror/theme.ts",
  " M packages/daemon/src/tui/mirror/app.tsx",
  " M docs/app/(home)/page.tsx",
  "?? docs/tui-web/host.ts",
].join("\n");

/** A genuine unified diff for the selected file. */
const DIFFS: Record<string, string> = {
  "packages/daemon/src/tui/mirror/theme.ts": `@@ -0,0 +1,8 @@
+import { RGBA } from "@opentui/core";
+
+/** The sidebar's surface — one lift above DEFAULT_BG. */
+export const SIDEBAR_BG = RGBA.fromInts(22, 22, 30, 255);
+export const ACCENT = RGBA.fromInts(130, 170, 255, 255);
+export const MUTED = RGBA.fromInts(110, 110, 130, 255);
+/** The selected row/tab. Always wins over HOVER_BG. */
+export const TAB_ACTIVE_BG = RGBA.fromInts(40, 46, 66, 255);`,
  "packages/daemon/src/tui/mirror/app.tsx": `@@ -6050,20 +6050,6 @@ function App() {
         <box flexDirection="row" flexGrow={1}>
-          <box
-            width={sidebarW()}
-            flexDirection="column"
-            backgroundColor={SIDEBAR_BG}
-            paddingLeft={1}
-          >
-            <text fg={ACCENT} attributes={1}>tmux-ide</text>
-            {/* …134 lines of inline sidebar… */}
-          </box>
+          <Sidebar
+            width={sidebarW()}
+            sessions={fleet()}
+            agents={fleetAgents()}
+            onMouse={(e) => route(e as RouteEvent)}
+          />`,
};

const FALLBACK_DIFF = `@@ -1,4 +1,4 @@
-const SIDEBAR_W = 30;
+const SIDEBAR_W = 32;
 const PANE_W = 62;`;

export function DiffScene() {
  // Staged-ness is state here: the [s stage] verb moves a file between groups.
  const [staged, setStaged] = createSignal<Set<string>>(new Set());
  const [sel, setSel] = createSignal(0);

  const entries = createMemo<DiffEntry[]>(() => {
    const base = parseStatusGroups(PORCELAIN);
    const moved = staged();
    if (moved.size === 0) return base;
    // Re-run the app's own parser over porcelain text that reflects the staging,
    // rather than hand-mutating its output — the model stays the source of truth.
    const lines = PORCELAIN.split("\n").map((l) => {
      const path = l.slice(3);
      return moved.has(path) ? `M  ${path}` : l;
    });
    return parseStatusGroups(lines.join("\n"));
  });

  const rows = createMemo(() => buildDiffRows(entries()));
  const files = createMemo(() => rows().files);
  const current = createMemo(() => files()[Math.min(sel(), files().length - 1)]);
  const hunks = createMemo(() =>
    classifyDiff(DIFFS[current()?.path ?? ""] ?? FALLBACK_DIFF).slice(0, ROWS - 2),
  );

  const lineFg = (kind: string) =>
    kind === "add"
      ? STATUS_COLOR.idle
      : kind === "del"
        ? STATUS_COLOR.blocked
        : kind === "hunk"
          ? ACCENT
          : MUTED;

  return (
    <box flexDirection="row" backgroundColor={DEFAULT_BG}>
      {/* The file list — groups and rows from buildDiffRows. */}
      <box flexDirection="column" width={LIST_W} height={ROWS} paddingLeft={1} overflow="hidden">
        <For each={rows().rows}>
          {(row) => {
            if (row.kind === "header") {
              return (
                <text fg={MUTED} attributes={1}>
                  {row.label}
                </text>
              );
            }
            // The model already carries the row's index into the flat file
            // order — use it rather than re-deriving one that could disagree.
            const i = () => row.fileIndex;
            const isSel = () => i() === sel();
            return (
              <box
                flexDirection="row"
                gap={1}
                backgroundColor={isSel() ? TAB_ACTIVE_BG : DEFAULT_BG}
                onMouse={(e) => {
                  if (e.type === "down") setSel(i());
                }}
              >
                <text fg={row.entry.status === "?" ? MUTED : ACCENT}>{row.entry.status}</text>
                <text fg={isSel() ? DEFAULT_FG : MUTED}>
                  {row.entry.path
                    .split("/")
                    .slice(-1)[0]!
                    .slice(0, LIST_W - 12)}
                </text>
                <box flexGrow={1} />
                <text fg={STATUS_COLOR.idle}>
                  {row.entry.additions ? `+${row.entry.additions}` : ""}
                </text>
              </box>
            );
          }}
        </For>

        <box flexGrow={1} />
        <box flexDirection="row" gap={1}>
          <text
            fg={DEFAULT_FG}
            bg={DEMO_PANEL_BG}
            onMouse={(e) => {
              if (e.type !== "down") return;
              const f = current();
              if (!f) return;
              setStaged((s) => new Set(s).add(f.path));
            }}
          >
            {" [s stage] "}
          </text>
          <text
            fg={MUTED}
            bg={DEMO_PANEL_BG}
            onMouse={(e) => {
              if (e.type === "down") setStaged(new Set<string>());
            }}
          >
            {" [reset] "}
          </text>
        </box>
      </box>

      {/* The hunks — classifyDiff decides every color here. */}
      <box flexDirection="column" width={HUNK_W} height={ROWS} paddingLeft={1} overflow="hidden">
        <text fg={ACCENT}>{current()?.path ?? ""}</text>
        <Show when={current()}>
          <For each={hunks()}>
            {(line) => <text fg={lineFg(line.kind)}>{line.text.slice(0, HUNK_W - 2)}</text>}
          </For>
        </Show>
      </box>
    </box>
  );
}
