import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { RGBA, TextAttributes } from "@opentui/core";
import {
  createSignal,
  createMemo,
  createEffect,
  onMount,
  onCleanup,
  batch,
  Show,
  For,
} from "solid-js";
import { createTheme } from "../lib/theme.ts";
import { getAppConfig } from "../../lib/app-config.ts";
import { getGitBranch } from "../lib/git.ts";
import { watchDirectory } from "../lib/watcher.ts";
import { matchGrammar } from "../lib/grammar.ts";
import { HelpOverlay, type WidgetKey } from "../lib/help-overlay.tsx";
import { findPaneByTitle, sendCommand, findPaneByPattern } from "../lib/pane-comms.ts";

/** Changes keys beyond the shared grammar — listed in the `?` overlay. */
const WIDGET_KEYS: WidgetKey[] = [
  { key: "s / u", label: "stage / unstage file" },
  { key: "S / U", label: "stage / unstage all" },
  { key: "c", label: "send to claude" },
  { key: "r", label: "refresh" },
  { key: "g / G", label: "top / bottom" },
];

const { values } = parseArgs({
  options: {
    session: { type: "string" },
    dir: { type: "string" },
    target: { type: "string" },
    theme: { type: "string" },
  },
});

const session = values.session ?? "";
const dir = values.dir ?? process.cwd();
const targetTitle = values.target ?? null;
const themeConfig = values.theme ? JSON.parse(values.theme) : undefined;

// --- Git helpers ---

function execGit(args: string[]): string {
  try {
    return execFileSync(
      "git",
      ["-c", "core.fsmonitor=false", "-c", "core.quotepath=false", ...args],
      { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return "";
  }
}

interface ChangedFile {
  path: string;
  status: "M" | "A" | "D" | "?";
  staged: boolean;
  additions: number;
  deletions: number;
}

interface ChangesState {
  staged: ChangedFile[];
  unstaged: ChangedFile[];
  untracked: ChangedFile[];
}

function getChanges(): ChangesState {
  const staged: ChangedFile[] = [];
  const unstaged: ChangedFile[] = [];
  const untracked: ChangedFile[] = [];

  // Staged deleted files
  const stagedDeleted = new Set(
    execGit(["diff", "--cached", "--name-only", "--diff-filter=D"]).split("\n").filter(Boolean),
  );

  // Staged changes
  for (const line of execGit(["diff", "--cached", "--numstat"]).split("\n").filter(Boolean)) {
    const parts = line.split("\t");
    if (parts.length < 3 || parts[0] === "-") continue;
    const filepath = parts.slice(2).join("\t");
    staged.push({
      path: filepath,
      status: stagedDeleted.has(filepath) ? "D" : "M",
      staged: true,
      additions: parseInt(parts[0]!, 10) || 0,
      deletions: parseInt(parts[1]!, 10) || 0,
    });
  }
  // Staged deleted not in numstat
  for (const filepath of stagedDeleted) {
    if (!staged.some((f) => f.path === filepath)) {
      staged.push({ path: filepath, status: "D", staged: true, additions: 0, deletions: 0 });
    }
  }

  // Unstaged deleted files
  const unstagedDeleted = new Set(
    execGit(["diff", "--name-only", "--diff-filter=D"]).split("\n").filter(Boolean),
  );

  // Unstaged changes
  for (const line of execGit(["diff", "--numstat"]).split("\n").filter(Boolean)) {
    const parts = line.split("\t");
    if (parts.length < 3 || parts[0] === "-") continue;
    const filepath = parts.slice(2).join("\t");
    unstaged.push({
      path: filepath,
      status: unstagedDeleted.has(filepath) ? "D" : "M",
      staged: false,
      additions: parseInt(parts[0]!, 10) || 0,
      deletions: parseInt(parts[1]!, 10) || 0,
    });
  }
  for (const filepath of unstagedDeleted) {
    if (!unstaged.some((f) => f.path === filepath)) {
      unstaged.push({ path: filepath, status: "D", staged: false, additions: 0, deletions: 0 });
    }
  }

  // Untracked files
  for (const filepath of execGit(["ls-files", "--others", "--exclude-standard"])
    .split("\n")
    .filter(Boolean)) {
    let additions = 0;
    try {
      additions = readFileSync(join(dir, filepath), "utf-8").split("\n").length;
    } catch {
      /* ignore */
    }
    untracked.push({ path: filepath, status: "?", staged: false, additions, deletions: 0 });
  }

  return { staged, unstaged, untracked };
}

function getChangeDiff(file: ChangedFile): string {
  if (file.status === "?") {
    // Untracked: show all content as additions
    try {
      const content = readFileSync(join(dir, file.path), "utf-8");
      return content
        .split("\n")
        .map((l) => `+${l}`)
        .join("\n");
    } catch {
      return "";
    }
  }
  const args = file.staged ? ["diff", "--cached", "--", file.path] : ["diff", "--", file.path];
  return execGit(args);
}

function stageFile(path: string): void {
  execGit(["add", "--", path]);
}

function unstageFile(path: string): void {
  execGit(["reset", "HEAD", "--", path]);
}

function stageAll(): void {
  execGit(["add", "-A"]);
}

function unstageAll(): void {
  execGit(["reset", "HEAD"]);
}

// --- Rendering ---

function toRGBA(c: { r: number; g: number; b: number; a: number }): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
}

const TRANSPARENT = RGBA.fromInts(0, 0, 0, 0);

type ListItem =
  | { kind: "header"; label: string }
  | { kind: "file"; file: ChangedFile; globalIndex: number };

/** Narrow every group of a {@link ChangesState} to files whose path matches the
 *  (case-insensitive) query. An empty query returns the state unchanged. */
function filterChanges(changes: ChangesState, query: string): ChangesState {
  const q = query.trim().toLowerCase();
  if (!q) return changes;
  const match = (f: ChangedFile) => f.path.toLowerCase().includes(q);
  return {
    staged: changes.staged.filter(match),
    unstaged: changes.unstaged.filter(match),
    untracked: changes.untracked.filter(match),
  };
}

function buildListItems(changes: ChangesState): { items: ListItem[]; fileCount: number } {
  const items: ListItem[] = [];
  let globalIndex = 0;

  if (changes.staged.length > 0) {
    items.push({ kind: "header", label: `Staged (${changes.staged.length})` });
    for (const file of changes.staged) {
      items.push({ kind: "file", file, globalIndex });
      globalIndex++;
    }
  }
  if (changes.unstaged.length > 0) {
    items.push({ kind: "header", label: `Unstaged (${changes.unstaged.length})` });
    for (const file of changes.unstaged) {
      items.push({ kind: "file", file, globalIndex });
      globalIndex++;
    }
  }
  if (changes.untracked.length > 0) {
    items.push({ kind: "header", label: `Untracked (${changes.untracked.length})` });
    for (const file of changes.untracked) {
      items.push({ kind: "file", file, globalIndex });
      globalIndex++;
    }
  }
  return { items, fileCount: globalIndex };
}

render(
  () => {
    const theme = createTheme(themeConfig, getAppConfig().theme);
    const dimensions = useTerminalDimensions();

    const [changes, setChanges] = createSignal<ChangesState>(getChanges());
    const [branch, setBranch] = createSignal(getGitBranch(dir));
    const [selected, setSelected] = createSignal(0);
    const [diffContent, setDiffContent] = createSignal<string | null>(null);
    const [inputMode, setInputMode] = createSignal<"keyboard" | "mouse">("keyboard");
    const [filterMode, setFilterMode] = createSignal(false);
    const [filterQuery, setFilterQuery] = createSignal("");
    const [helpOpen, setHelpOpen] = createSignal(false);

    // The visible file set narrows to the `/` filter query while filtering; the
    // list, diff selection, and staging all read through it.
    const visibleChanges = createMemo(() =>
      filterMode() ? filterChanges(changes(), filterQuery()) : changes(),
    );

    const allFiles = createMemo(() => [
      ...visibleChanges().staged,
      ...visibleChanges().unstaged,
      ...visibleChanges().untracked,
    ]);

    const listData = createMemo(() => buildListItems(visibleChanges()));

    const totalAdditions = createMemo(() => allFiles().reduce((s, f) => s + f.additions, 0));
    const totalDeletions = createMemo(() => allFiles().reduce((s, f) => s + f.deletions, 0));

    // Load diff when selection changes
    createEffect(() => {
      const file = allFiles()[selected()];
      if (file) {
        try {
          setDiffContent(getChangeDiff(file));
        } catch {
          setDiffContent(null);
        }
      } else {
        setDiffContent(null);
      }
    });

    // File watcher
    let stopWatch: (() => Promise<void>) | null = null;
    onMount(async () => {
      try {
        stopWatch = await watchDirectory(
          dir,
          () => {
            batch(() => {
              setChanges(getChanges());
              setBranch(getGitBranch(dir));
            });
          },
          { debounceMs: 500 },
        );
      } catch {
        /* watcher unavailable */
      }
    });
    onCleanup(async () => {
      await stopWatch?.();
    });

    function resolveTargetPane(): string | null {
      if (!session) return null;
      if (targetTitle) return findPaneByTitle(session, targetTitle);
      return findPaneByPattern(session, "claude");
    }

    // Keyboard
    useKeyboard((evt) => {
      setInputMode("keyboard");

      // Help overlay swallows keys: esc / q / ? close it.
      if (helpOpen()) {
        const g = matchGrammar(evt);
        if (g === "dismiss" || g === "quit" || g === "help") setHelpOpen(false);
        evt.preventDefault();
        return;
      }

      // The `/` filter narrows the file list. Per the grammar's escape
      // precedence esc closes the FILTER first; arrows navigate, typing narrows.
      if (filterMode()) {
        if (evt.name === "escape" || evt.name === "return") {
          setFilterMode(false);
          setFilterQuery("");
          setSelected(0);
          evt.preventDefault();
          return;
        }
        if (evt.name === "up") {
          setSelected((i) => Math.max(0, i - 1));
          evt.preventDefault();
          return;
        }
        if (evt.name === "down") {
          setSelected((i) => Math.min(allFiles().length - 1, i + 1));
          evt.preventDefault();
          return;
        }
        if (evt.name === "backspace") {
          setFilterQuery((q) => q.slice(0, -1));
          setSelected(0);
          evt.preventDefault();
          return;
        }
        if (evt.name.length === 1 && !evt.ctrl && !evt.alt && !evt.meta) {
          setFilterQuery((q) => q + evt.name);
          setSelected(0);
          evt.preventDefault();
          return;
        }
        return;
      }

      const files = allFiles();

      // The shared grammar runs FIRST; git/staging keys fall through below.
      const grammar = matchGrammar(evt);
      if (grammar === "navUp") {
        setSelected((i) => Math.max(0, i - 1));
        evt.preventDefault();
        return;
      } else if (grammar === "navDown") {
        setSelected((i) => Math.min(files.length - 1, i + 1));
        evt.preventDefault();
        return;
      } else if (grammar === "filter") {
        setFilterMode(true);
        setFilterQuery("");
        setSelected(0);
        evt.preventDefault();
        return;
      } else if (grammar === "help") {
        setHelpOpen(true);
        evt.preventDefault();
        return;
      } else if (grammar === "dismiss" || grammar === "quit") {
        // Nothing is layered here, so esc/q close the panel popup.
        process.exit(0);
      }

      if (evt.name === "s" && !evt.shift) {
        const file = files[selected()];
        if (file && !file.staged) {
          stageFile(file.path);
          setChanges(getChanges());
        }
        evt.preventDefault();
      } else if (evt.name === "u" && !evt.shift) {
        const file = files[selected()];
        if (file && file.staged) {
          unstageFile(file.path);
          setChanges(getChanges());
        }
        evt.preventDefault();
      } else if (evt.shift && evt.name === "s") {
        stageAll();
        setChanges(getChanges());
        evt.preventDefault();
      } else if (evt.shift && evt.name === "u") {
        unstageAll();
        setChanges(getChanges());
        evt.preventDefault();
      } else if (evt.name === "c") {
        const file = files[selected()];
        if (file) {
          const targetId = resolveTargetPane();
          if (targetId) sendCommand(session, targetId, `read ${file.path}`);
        }
        evt.preventDefault();
      } else if (evt.name === "r") {
        batch(() => {
          setChanges(getChanges());
          setBranch(getGitBranch(dir));
        });
        evt.preventDefault();
      } else if (evt.name === "g" && !evt.shift) {
        setSelected(0);
        evt.preventDefault();
      } else if (evt.shift && evt.name === "g") {
        setSelected(files.length - 1);
        evt.preventDefault();
      }
    });

    const listHeight = createMemo(() => Math.max(5, Math.floor(dimensions().height * 0.4)));

    const diffLines = createMemo(() => {
      const d = diffContent();
      if (!d) return [];
      return d.split("\n");
    });

    return (
      <box
        width={dimensions().width}
        height={dimensions().height}
        backgroundColor={toRGBA(theme.bg)}
      >
        <Show when={helpOpen()}>
          <HelpOverlay theme={theme} title="changes" widgetKeys={WIDGET_KEYS} />
        </Show>
        <Show when={!helpOpen()}>
          {/* Header */}
          <box flexShrink={0} paddingLeft={1} paddingBottom={1} flexDirection="row" gap={2}>
            <Show when={branch()}>
              <text fg={toRGBA(theme.accent)} attributes={TextAttributes.BOLD}>
                {"⎇ "}
                {branch()}
              </text>
            </Show>
            <text fg={toRGBA(theme.fg)} attributes={TextAttributes.BOLD}>
              Changes
            </text>
            <Show when={totalAdditions() > 0}>
              <text fg={toRGBA(theme.gitAdded)}>+{totalAdditions()}</text>
            </Show>
            <Show when={totalDeletions() > 0}>
              <text fg={toRGBA(theme.gitDeleted)}>-{totalDeletions()}</text>
            </Show>
            <text fg={toRGBA(theme.fgMuted)}>{allFiles().length} files</text>
          </box>

          {/* Filter line */}
          <Show when={filterMode()}>
            <box flexShrink={0} paddingLeft={1} flexDirection="row" gap={1}>
              <text fg={toRGBA(theme.accent)}>/</text>
              <text fg={toRGBA(theme.fg)}>{filterQuery()}</text>
              <text fg={toRGBA(theme.fgMuted)}>_</text>
            </box>
          </Show>

          {/* File list */}
          <scrollbox maxHeight={listHeight()} flexShrink={0}>
            <Show
              when={allFiles().length > 0}
              fallback={
                <box paddingLeft={2} paddingTop={1}>
                  <text fg={toRGBA(theme.fgMuted)}>All clean ✓</text>
                </box>
              }
            >
              <For each={listData().items}>
                {(item) => {
                  if (item.kind === "header") {
                    return (
                      <box paddingTop={1}>
                        <text fg={toRGBA(theme.accent)} attributes={TextAttributes.BOLD}>
                          {"  "}
                          {item.label}
                        </text>
                      </box>
                    );
                  }
                  const isSelected = createMemo(() => item.globalIndex === selected());
                  const statusColor = () => {
                    if (item.file.staged) return theme.gitAdded;
                    switch (item.file.status) {
                      case "M":
                        return theme.gitModified;
                      case "D":
                        return theme.gitDeleted;
                      case "?":
                        return theme.gitUntracked;
                      default:
                        return theme.fgMuted;
                    }
                  };
                  return (
                    <box
                      flexDirection="row"
                      paddingLeft={1}
                      paddingRight={1}
                      backgroundColor={isSelected() ? toRGBA(theme.selected) : TRANSPARENT}
                      onMouseMove={() => setInputMode("mouse")}
                      onMouseDown={() => setSelected(item.globalIndex)}
                      onMouseOver={() => {
                        if (inputMode() === "mouse") setSelected(item.globalIndex);
                      }}
                    >
                      <text fg={toRGBA(statusColor())} wrapMode="none" flexShrink={0}>
                        {"  "}
                        {item.file.status}{" "}
                      </text>
                      <text
                        fg={toRGBA(isSelected() ? theme.selectedText : theme.fg)}
                        wrapMode="none"
                        flexGrow={1}
                      >
                        {item.file.path}
                      </text>
                      <Show when={item.file.additions > 0}>
                        <text fg={toRGBA(theme.gitAdded)} flexShrink={0} wrapMode="none">
                          {" +"}
                          {item.file.additions}
                        </text>
                      </Show>
                      <Show when={item.file.deletions > 0}>
                        <text fg={toRGBA(theme.gitDeleted)} flexShrink={0} wrapMode="none">
                          {" -"}
                          {item.file.deletions}
                        </text>
                      </Show>
                      <Show when={isSelected()}>
                        <text
                          fg={toRGBA(theme.fgMuted)}
                          flexShrink={0}
                          wrapMode="none"
                          onMouseUp={() => {
                            if (item.file.staged) {
                              unstageFile(item.file.path);
                            } else {
                              stageFile(item.file.path);
                            }
                            setChanges(getChanges());
                          }}
                        >
                          {item.file.staged ? " u:unstage" : " s:stage"}
                        </text>
                      </Show>
                    </box>
                  );
                }}
              </For>
            </Show>
          </scrollbox>

          {/* Separator */}
          <box flexShrink={0} height={1}>
            <text fg={toRGBA(theme.border)} wrapMode="none">
              {"─".repeat(dimensions().width)}
            </text>
          </box>

          {/* Diff preview */}
          <Show
            when={diffContent()}
            fallback={
              <box flexGrow={1} paddingLeft={2} paddingTop={1}>
                <text fg={toRGBA(theme.fgMuted)}>Select a file to preview changes</text>
              </box>
            }
          >
            <scrollbox flexGrow={1}>
              <For each={diffLines()}>
                {(line) => {
                  const fg = line.startsWith("+")
                    ? theme.diffAdded
                    : line.startsWith("-")
                      ? theme.diffRemoved
                      : line.startsWith("@@")
                        ? theme.diffHunk
                        : theme.diffContext;
                  const bg = line.startsWith("+")
                    ? theme.diffAddedBg
                    : line.startsWith("-")
                      ? theme.diffRemovedBg
                      : theme.diffContextBg;
                  return (
                    <box backgroundColor={toRGBA(bg)}>
                      <text fg={toRGBA(fg)} wrapMode="none">
                        {line || " "}
                      </text>
                    </box>
                  );
                }}
              </For>
            </scrollbox>
          </Show>

          {/* Footer */}
          <box flexShrink={0} paddingLeft={1} paddingTop={1} flexDirection="row" gap={1}>
            <text fg={toRGBA(theme.fgMuted)} wrapMode="none">
              ↑↓:nav
            </text>
            <text
              fg={toRGBA(theme.fgMuted)}
              wrapMode="none"
              onMouseUp={() => {
                const file = allFiles()[selected()];
                if (file && !file.staged) {
                  stageFile(file.path);
                  setChanges(getChanges());
                }
              }}
            >
              s:stage
            </text>
            <text
              fg={toRGBA(theme.fgMuted)}
              wrapMode="none"
              onMouseUp={() => {
                const file = allFiles()[selected()];
                if (file && file.staged) {
                  unstageFile(file.path);
                  setChanges(getChanges());
                }
              }}
            >
              u:unstage
            </text>
            <text
              fg={toRGBA(theme.fgMuted)}
              wrapMode="none"
              onMouseUp={() => {
                stageAll();
                setChanges(getChanges());
              }}
            >
              S:all
            </text>
            <text
              fg={toRGBA(theme.fgMuted)}
              wrapMode="none"
              onMouseUp={() => {
                unstageAll();
                setChanges(getChanges());
              }}
            >
              U:all
            </text>
            <text
              fg={toRGBA(theme.fgMuted)}
              wrapMode="none"
              onMouseUp={() => {
                batch(() => {
                  setChanges(getChanges());
                  setBranch(getGitBranch(dir));
                });
              }}
            >
              r:refresh
            </text>
            <text fg={toRGBA(theme.fgMuted)} wrapMode="none">
              /:filter
            </text>
            <text fg={toRGBA(theme.fgMuted)} wrapMode="none">
              ?:help
            </text>
            <text fg={toRGBA(theme.fgMuted)} wrapMode="none">
              q:quit
            </text>
          </box>
        </Show>
      </box>
    );
  },
  {
    targetFps: 30,
    exitOnCtrlC: true,
    useKittyKeyboard: {},
    autoFocus: false,
  },
);
