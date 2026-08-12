import { basename, join } from "node:path";

import type { WorkspaceChangesCatalogEnvelopeV1 } from "@tmux-ide/contracts";
import { createRoot, createSignal } from "solid-js";

import {
  changesBodyRows,
  changesHitTest,
  projectChangesSurface,
  type ChangesActionId,
  type ChangesSurfaceInput,
} from "../../changes-surface.ts";
import {
  buildDiffRows,
  classifyDiff,
  clampSel,
  filterEntries,
  hunkEditTarget,
  nextHunkTop,
  rowIndexOfFile,
  totalCounts,
  untrackedDiffText,
  type DiffEntry,
  type DiffGroup,
} from "../../diff-model.ts";
import { isBinary } from "../../runtime/file-content-primitives.ts";
import { clampTop, scrollToCursor } from "../../runtime/editor-primitives.ts";
import type {
  ChangesContextTarget,
  ChangesFeatureHost,
  ChangesFeatureSession,
  ChangesHoverTarget,
  ChangesKeyEvent,
  ChangesPointerEvent,
} from "./contract.ts";

const DEFAULT_SCROLL_STEP = 3;

const statusLetter = (status: string): string =>
  ({
    modified: "M",
    added: "A",
    deleted: "D",
    renamed: "R",
    copied: "C",
    "type-changed": "T",
    conflicted: "U",
    untracked: "?",
  })[status] ?? "M";

const projectionHover = (hover: ChangesHoverTarget | null): ChangesSurfaceInput["hovered"] => {
  if (!hover) return null;
  if (hover.kind === "header-action") return { region: "button", index: hover.index };
  if (hover.kind === "footer-action") return { region: "diffverb", index: hover.index };
  return { region: "diff", index: hover.index };
};

/**
 * Owns the complete demand-loaded Changes interaction model.
 *
 * The controller has its own explicitly disposed Solid owner because its module
 * is imported after the application root has mounted. All asynchronous Git
 * callbacks are fenced by both workspace generation and selected-read token, so
 * a retired controller or an earlier workspace can never publish late state.
 */
export function createChangesFeatureController(
  host: ChangesFeatureHost,
  initialDirectory: string,
): ChangesFeatureSession {
  return createRoot((disposeOwner) => {
    const [directory, setDirectory] = createSignal(initialDirectory);
    const [entries, setEntries] = createSignal<DiffEntry[]>([]);
    const [selected, setSelected] = createSignal(0);
    const [diffText, setDiffText] = createSignal("");
    const [diffTop, setDiffTop] = createSignal(0);
    const [fileTop, setFileTop] = createSignal(0);
    const [message, setMessage] = createSignal("");
    const [filter, setFilter] = createSignal<string | null>(null);
    let pendingPath: string | null = null;
    let pendingGroup: DiffGroup | null = null;
    let readToken = 0;
    let generation = 1;
    let disposed = false;

    const bodyRows = () => Math.max(1, changesBodyRows(host.height()));
    let cachedDiffText: string | null = null;
    let cachedLines: ReturnType<typeof classifyDiff> = [];
    const lines = () => {
      const text = diffText();
      if (text !== cachedDiffText) {
        cachedDiffText = text;
        cachedLines = classifyDiff(text);
      }
      return cachedLines;
    };
    let cachedEntries: DiffEntry[] | null = null;
    let cachedFilter: string | null = null;
    let cachedRowsData: ReturnType<typeof buildDiffRows> = { rows: [], files: [] };
    const rowsData = () => {
      const source = entries();
      const query = filter();
      if (source !== cachedEntries || query !== cachedFilter) {
        cachedEntries = source;
        cachedFilter = query;
        cachedRowsData = buildDiffRows(filterEntries(source, query ?? ""));
      }
      return cachedRowsData;
    };
    const rows = () => rowsData().rows;
    const visibleFiles = () => rowsData().files;
    const visibleLines = () => {
      const all = lines();
      const top = clampTop(diffTop(), all.length, bodyRows());
      return all.slice(top, top + bodyRows());
    };
    const visibleRows = () => {
      const all = rows();
      const top = clampTop(fileTop(), all.length, bodyRows());
      return all.slice(top, top + bodyRows()).map((row, offset) => ({
        row,
        rowIndex: top + offset,
      }));
    };
    const projection = () =>
      projectChangesSurface({
        width: host.width(),
        height: host.height(),
        dir: directory(),
        fileCount: visibleFiles().length,
        totals: totalCounts(visibleFiles()),
        filterQuery: filter(),
        message: message(),
        listRows: visibleRows(),
        selectedFileIndex: selected(),
        diffLines: visibleLines(),
        hovered: projectionHover(host.hover()),
        footerHint: "]/[ hunk · ^e edit · / filter · r refresh · ^g home · ^q quit",
      });

    const current = (): DiffEntry | undefined => visibleFiles()[selected()];
    const alive = (expectedGeneration: number): boolean =>
      !disposed && expectedGeneration === generation;

    const loadDiff = (entry: DiffEntry): void => {
      const token = ++readToken;
      const expectedGeneration = generation;
      setMessage("");
      if (entry.group === "untracked") {
        try {
          const bytes = host.readFile(join(directory(), entry.path));
          if (!alive(expectedGeneration) || token !== readToken) return;
          if (isBinary(bytes)) {
            setDiffText("");
            setMessage("binary file");
          } else {
            setDiffText(untrackedDiffText(Buffer.from(bytes).toString("utf8")));
          }
        } catch (error) {
          if (!alive(expectedGeneration) || token !== readToken) return;
          setDiffText("");
          setMessage(`cannot read: ${(error as Error).message}`);
        }
        return;
      }
      const args =
        entry.group === "staged"
          ? ["diff", "--no-color", "--cached", "--", entry.path]
          : ["diff", "--no-color", "--", entry.path];
      host.runGit(directory(), args, (stdout) => {
        if (!alive(expectedGeneration) || token !== readToken) return;
        setDiffText((previous) => (previous === stdout ? previous : stdout));
      });
    };

    const selectFile = (index: number): void => {
      const files = visibleFiles();
      if (files.length === 0) return;
      const next = clampSel(index, files.length);
      setSelected(next);
      setDiffTop(0);
      const rowIndex = rowIndexOfFile(rows(), next);
      if (rowIndex !== -1) {
        setFileTop((top) => scrollToCursor(rowIndex, top, bodyRows(), rows().length));
      }
      loadDiff(files[next]!);
    };

    const reselectFilter = (): void => {
      if (visibleFiles().length === 0) {
        setSelected(0);
        setDiffText("");
      } else {
        selectFile(0);
      }
    };

    const mutate = (args: readonly string[], done: () => void): void => {
      const expectedGeneration = generation;
      host.runGit(directory(), args, () => {
        if (!alive(expectedGeneration)) return;
        done();
      });
    };

    const stage = (entry: DiffEntry): void => {
      if (entry.group === "staged") {
        host.setStatusNote("already staged");
        return;
      }
      mutate(["add", "--", entry.path], () => {
        pendingPath = entry.path;
        pendingGroup = "staged";
        host.setStatusNote(`staged ${entry.path}`);
        host.refreshResource();
      });
    };

    const unstage = (entry: DiffEntry): void => {
      if (entry.group !== "staged") {
        host.setStatusNote("not staged");
        return;
      }
      mutate(["reset", "HEAD", "--", entry.path], () => {
        pendingPath = entry.path;
        pendingGroup = "unstaged";
        host.setStatusNote(`unstaged ${entry.path}`);
        host.refreshResource();
      });
    };

    const stageAll = (): void => {
      const entry = current();
      mutate(["add", "-A"], () => {
        if (entry) {
          pendingPath = entry.path;
          pendingGroup = "staged";
        }
        host.setStatusNote("staged all changes");
        host.refreshResource();
      });
    };

    const unstageAll = (): void => {
      const entry = current();
      mutate(["reset", "HEAD"], () => {
        if (entry) {
          pendingPath = entry.path;
          pendingGroup = entry.group === "staged" ? "unstaged" : entry.group;
        }
        host.setStatusNote("unstaged all");
        host.refreshResource();
      });
    };

    const runAction = (action: ChangesActionId, fileIndex = selected()): void => {
      if (action === "refresh") host.refreshResource();
      else if (action === "stage-all") stageAll();
      else if (action === "unstage-all") unstageAll();
      else {
        const entry = visibleFiles()[fileIndex];
        if (!entry) return;
        if (action === "stage" || action === "row-stage") stage(entry);
        else if (action === "unstage" || action === "row-unstage") unstage(entry);
      }
    };

    const jumpHunk = (direction: 1 | -1): void => {
      const all = lines();
      const currentTop = clampTop(diffTop(), all.length, bodyRows());
      const next = nextHunkTop(all, currentTop, direction);
      if (next !== null) setDiffTop(clampTop(next, all.length, bodyRows()));
    };

    const openSelected = (): void => {
      const entry = current();
      if (!entry) return;
      const all = lines();
      const line = hunkEditTarget(all, clampTop(diffTop(), all.length, bodyRows()));
      host.openEditor(join(directory(), entry.path), line ?? undefined);
    };

    const reset = (nextMessage = ""): void => {
      generation += 1;
      readToken += 1;
      pendingPath = null;
      pendingGroup = null;
      setEntries([]);
      setSelected(0);
      setDiffText("");
      setDiffTop(0);
      setFileTop(0);
      setMessage(nextMessage);
      setFilter(null);
    };

    const prepare = (nextDirectory: string): void => {
      reset();
      setDirectory(nextDirectory);
      host.refreshResource();
    };

    const restoreSelectedPath = (path: string | null): void => {
      pendingPath = path;
      pendingGroup = null;
      if (!path || visibleFiles().length === 0) return;
      const index = visibleFiles().findIndex((entry) => entry.path === path);
      if (index < 0) return;
      pendingPath = null;
      selectFile(index);
    };

    const applyCatalog = (envelope: WorkspaceChangesCatalogEnvelopeV1): void => {
      if (disposed) return;
      const resource = envelope.resource;
      if (resource.status !== "ready") {
        readToken += 1;
        setEntries([]);
        setDiffText("");
        setMessage(resource.message);
        return;
      }
      const nextEntries: DiffEntry[] = resource.entries.map((entry) => ({
        group: entry.group,
        status: statusLetter(entry.status),
        path: entry.relativePath,
        additions: entry.additions,
        deletions: entry.deletions,
      }));
      setEntries(nextEntries);
      if (nextEntries.length === 0) {
        readToken += 1;
        setDiffText("");
        setMessage("working tree clean");
        return;
      }
      setMessage("");
      let next = clampSel(selected(), nextEntries.length);
      if (pendingPath) {
        const exact = pendingGroup
          ? nextEntries.findIndex(
              (entry) => entry.path === pendingPath && entry.group === pendingGroup,
            )
          : -1;
        const fallback = nextEntries.findIndex((entry) => entry.path === pendingPath);
        if (exact >= 0 || fallback >= 0) next = exact >= 0 ? exact : fallback;
        pendingPath = null;
        pendingGroup = null;
      }
      setSelected(next);
      loadDiff(nextEntries[next]!);
    };

    const handleKey = (event: ChangesKeyEvent, mode: "filter" | "surface"): boolean => {
      if (disposed) return false;
      if (mode === "filter") {
        if (event.name === "escape" || event.name === "return") {
          setFilter(null);
          reselectFilter();
        } else if (event.name === "backspace") {
          setFilter((query) => (query ?? "").slice(0, -1));
          reselectFilter();
        } else if (event.name === "up") selectFile(selected() - 1);
        else if (event.name === "down") selectFile(selected() + 1);
        else if (event.name.length === 1 && !event.ctrl && !event.meta) {
          setFilter(
            (query) => (query ?? "") + (event.shift ? event.name.toUpperCase() : event.name),
          );
          reselectFilter();
        }
        return true;
      }
      if (event.ctrl && event.name === "e") openSelected();
      else if (event.name === "j" || event.name === "down") selectFile(selected() + 1);
      else if (event.name === "k" || event.name === "up") selectFile(selected() - 1);
      else if (event.name === "s" && event.shift) stageAll();
      else if (event.name === "u" && event.shift) unstageAll();
      else if (event.name === "s") {
        const entry = current();
        if (entry) stage(entry);
      } else if (event.name === "u") {
        const entry = current();
        if (entry) unstage(entry);
      } else if (event.name === "]") jumpHunk(1);
      else if (event.name === "[") jumpHunk(-1);
      else if (event.name === "/" && !event.ctrl && !event.meta) setFilter("");
      else if (event.name === "r") host.refreshResource();
      else return false;
      return true;
    };

    const hoverTargetAt = (x: number, y: number): ChangesHoverTarget | null => {
      const hit = changesHitTest(projection(), x, y);
      if (hit?.area === "header" && hit.actionIndex !== undefined)
        return { kind: "header-action", index: hit.actionIndex };
      if (hit?.area === "footer" && hit.actionIndex !== undefined)
        return { kind: "footer-action", index: hit.actionIndex };
      if (hit?.area === "list" && hit.rowIndex !== undefined)
        return { kind: "list-row", index: hit.rowIndex };
      return null;
    };

    const handlePointer = (event: ChangesPointerEvent): boolean => {
      if (disposed) return false;
      const hit = changesHitTest(projection(), event.x, event.y);
      if (event.type === "scroll") {
        if (event.direction !== "up" && event.direction !== "down") return true;
        const step =
          (event.direction === "up" ? -1 : 1) * (event.scrollStep ?? DEFAULT_SCROLL_STEP);
        if (hit?.area === "list")
          setFileTop((top) => clampTop(top + step, rows().length, bodyRows()));
        else setDiffTop((top) => clampTop(top + step, lines().length, bodyRows()));
        return true;
      }
      if (event.button === 2) return true;
      if ((hit?.area === "header" || hit?.area === "footer") && hit.actionId) {
        runAction(hit.actionId);
      } else if (hit?.area === "list" && hit.fileIndex !== undefined) {
        if (hit.actionId) runAction(hit.actionId, hit.fileIndex);
        else selectFile(hit.fileIndex);
      }
      return true;
    };

    const contextTargetAt = (x: number, y: number): ChangesContextTarget | null => {
      const hit = changesHitTest(projection(), x, y);
      if (hit?.area !== "list" || hit.fileIndex === undefined) return null;
      const entry = visibleFiles()[hit.fileIndex];
      if (!entry) return null;
      return { title: basename(entry.path), path: join(directory(), entry.path) };
    };

    return {
      projection,
      directory,
      hasEntries: () => entries().length > 0,
      hasSelection: () => current() !== undefined,
      selectedPath: () => current()?.path ?? null,
      filterOpen: () => filter() !== null,
      prepare,
      reset,
      applyCatalog,
      restoreSelectedPath,
      handleKey,
      hoverTargetAt,
      handlePointer,
      contextTargetAt,
      scrollState: () => ({
        contentLength: lines().length,
        viewportRows: bodyRows(),
        top: clampTop(diffTop(), lines().length, bodyRows()),
      }),
      setScrollTop: (top) => setDiffTop(clampTop(top, lines().length, bodyRows())),
      dispose: () => {
        if (disposed) return;
        disposed = true;
        generation += 1;
        readToken += 1;
        disposeOwner();
      },
    };
  });
}
