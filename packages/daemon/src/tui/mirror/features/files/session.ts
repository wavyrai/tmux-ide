import { EditBuffer } from "@opentui/core";
import type { WorkspaceFilesCatalogEnvelopeV1 } from "@tmux-ide/contracts";
import ignore, { type Ignore } from "ignore";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createMemo, createRoot, createSignal, type Accessor, type Setter } from "solid-js";

import type { StatusEntry } from "../../diff-model.ts";
import {
  classifyFile,
  isBinary,
  readOnlyBanner,
  sanitizeForDisplay,
  type ReadOnlyReason,
} from "../../editor-buffer.ts";
import {
  shouldActivateFilesAfterEditorOpen,
  type EditorOpenOrigin,
} from "../../editor-open-policy.ts";
import type { HostedPanelKind } from "../../panel-host.ts";
import {
  ancestorDirs,
  buildNodes,
  changedFileWalk,
  filterEntries,
  filterView,
  indexOfPath,
  insertChildrenAt,
  nextChangedPath,
  relPath,
  removeSubtreeAt,
  statusMapFromEntries,
  type FileNode,
  type RawEntry,
} from "../../file-tree.ts";
import {
  filesHitTest,
  filesListWidth,
  projectFilesSurface,
  type FilesActionId,
  type FilesSurfaceProjection,
} from "../../files-surface.ts";
import {
  clampTop,
  clickToCursor,
  gutterWidth,
  scrollToCursor,
} from "../../runtime/editor-primitives.ts";

export interface FilesFeatureHost {
  readonly workspaceDir: () => string;
  readonly width: () => number;
  readonly height: () => number;
  readonly hover: () => { region: string; index: number } | null;
  readonly activePanel: () => HostedPanelKind;
  readonly mode: () => "home" | "mirror" | "editor" | "diff" | "missions";
  readonly activateFiles: () => void;
  readonly leaveFiles: (previous: "home" | "mirror") => void;
  readonly refresh: () => void;
  readonly note: (message: string) => void;
  readonly initialShowHidden: boolean;
  readonly initialShowIgnored: boolean;
  readonly quitHint: string;
}

export interface FilesKeyEvent {
  readonly name: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
}

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

export class FilesFeatureSession {
  readonly #host: FilesFeatureHost;
  #buffer: EditBuffer | null = null;
  #ignore: Ignore = ignore();
  #ignoreDir = "";
  #preFilterPath: string | null = null;
  #pendingSelectionPath: string | null = null;
  #previousMode: "home" | "mirror" = "home";
  fileNodes!: Accessor<FileNode[]>;
  setFileNodes!: Setter<FileNode[]>;
  fileSelection!: Accessor<number>;
  setFileSelection!: Setter<number>;
  fileTop!: Accessor<number>;
  setFileTop!: Setter<number>;
  showHidden!: Accessor<boolean>;
  setShowHidden!: Setter<boolean>;
  showIgnored!: Accessor<boolean>;
  setShowIgnored!: Setter<boolean>;
  statusEntries!: Accessor<StatusEntry[]>;
  setStatusEntries!: Setter<StatusEntry[]>;
  gitTop!: Accessor<string | null>;
  setGitTop!: Setter<string | null>;
  query!: Accessor<string | null>;
  setQuery!: Setter<string | null>;
  focus!: Accessor<"list" | "editor">;
  setFocus!: Setter<"list" | "editor">;
  editorPath!: Accessor<string | null>;
  setEditorPath!: Setter<string | null>;
  editorRevision!: Accessor<number>;
  setEditorRevision!: Setter<number>;
  editorTop!: Accessor<number>;
  setEditorTop!: Setter<number>;
  editorModified!: Accessor<boolean>;
  setEditorModified!: Setter<boolean>;
  editorReadOnly!: Accessor<ReadOnlyReason>;
  setEditorReadOnly!: Setter<ReadOnlyReason>;
  editorMessage!: Accessor<string>;
  setEditorMessage!: Setter<string>;
  visibleFiles!: Accessor<ReturnType<typeof filterView>>;
  editorRows!: () => number;
  editorLines!: Accessor<string[]>;
  editorCursor!: Accessor<{ row: number; col: number }>;
  projection!: Accessor<FilesSurfaceProjection>;
  readonly #disposeReactiveOwner: () => void;

  constructor(host: FilesFeatureHost) {
    this.#host = host;
    this.#disposeReactiveOwner = createRoot((dispose) => {
      const [fileNodes, setFileNodes] = createSignal<FileNode[]>([]);
      const [fileSelection, setFileSelection] = createSignal(0);
      const [fileTop, setFileTop] = createSignal(0);
      const [showHidden, setShowHidden] = createSignal(host.initialShowHidden);
      const [showIgnored, setShowIgnored] = createSignal(host.initialShowIgnored);
      const [statusEntries, setStatusEntries] = createSignal<StatusEntry[]>([]);
      const [gitTop, setGitTop] = createSignal<string | null>(null);
      const [query, setQuery] = createSignal<string | null>(null);
      const [focus, setFocus] = createSignal<"list" | "editor">("list");
      const [editorPath, setEditorPath] = createSignal<string | null>(null);
      const [editorRevision, setEditorRevision] = createSignal(0);
      const [editorTop, setEditorTop] = createSignal(0);
      const [editorModified, setEditorModified] = createSignal(false);
      const [editorReadOnly, setEditorReadOnly] = createSignal<ReadOnlyReason>(null);
      const [editorMessage, setEditorMessage] = createSignal("");
      const editorRows = () => Math.max(1, host.height() - 3);
      const visibleFiles = createMemo(() => filterView(fileNodes(), query()));
      const editorLines = createMemo(() => {
        editorRevision();
        return this.#buffer?.getText().split("\n") ?? [""];
      });
      const editorCursor = createMemo(() => {
        editorRevision();
        const cursor = this.#buffer?.getCursorPosition();
        return cursor ? { row: cursor.row, col: cursor.col } : { row: 0, col: 0 };
      });
      const projection = createMemo<FilesSurfaceProjection>(() => {
        const rows = visibleFiles();
        const viewport = editorRows();
        const top = clampTop(fileTop(), rows.length, viewport);
        const visibleRows = rows.slice(top, top + viewport).map((row, index) => ({
          node: row.node,
          index: top + index,
        }));
        const lines = editorLines();
        const editorTopValue = clampTop(editorTop(), lines.length, viewport);
        const cursor = editorCursor();
        const editorVisible = lines
          .slice(editorTopValue, editorTopValue + viewport)
          .map((text, index) => ({
            num: editorTopValue + index + 1,
            text,
            cursorCol: editorTopValue + index === cursor.row ? cursor.col : null,
          }));
        const statusMap = statusMapFromEntries(statusEntries());
        const currentGitTop = gitTop();

        return projectFilesSurface({
          width: host.width(),
          height: host.height(),
          workspaceDir: host.workspaceDir(),
          editorPath: editorPath(),
          editorModified: editorModified(),
          editorCursor: cursor,
          editorLineCount: lines.length,
          editorMessage: editorMessage(),
          readOnly: editorReadOnly(),
          filterQuery: query(),
          focus: focus(),
          showHidden: showHidden(),
          showIgnored: showIgnored(),
          visibleRows,
          totalRows: rows.length,
          fileSelection: fileSelection(),
          fileTop: fileTop(),
          editorVisible,
          editorTop: editorTop(),
          editorTotalLines: lines.length,
          hovered: ["files", "button"].includes(host.hover()?.region ?? "")
            ? (host.hover() as { region: "files" | "button"; index: number })
            : null,
          statusFor: (node) => {
            if (!currentGitTop) return null;
            const path = relPath(currentGitTop, node.path);
            return path ? (statusMap.get(path) ?? null) : null;
          },
          readOnlyBanner: readOnlyBanner(editorReadOnly()),
          footerBase: `j/k · enter open · [/] change · / filter · H dot:${showHidden() ? "on" : "off"} · I ign:${showIgnored() ? "on" : "off"} · ^s save · esc list · ^g home · ${host.quitHint}`,
        });
      });

      this.fileNodes = fileNodes;
      this.setFileNodes = setFileNodes;
      this.fileSelection = fileSelection;
      this.setFileSelection = setFileSelection;
      this.fileTop = fileTop;
      this.setFileTop = setFileTop;
      this.showHidden = showHidden;
      this.setShowHidden = setShowHidden;
      this.showIgnored = showIgnored;
      this.setShowIgnored = setShowIgnored;
      this.statusEntries = statusEntries;
      this.setStatusEntries = setStatusEntries;
      this.gitTop = gitTop;
      this.setGitTop = setGitTop;
      this.query = query;
      this.setQuery = setQuery;
      this.focus = focus;
      this.setFocus = setFocus;
      this.editorPath = editorPath;
      this.setEditorPath = setEditorPath;
      this.editorRevision = editorRevision;
      this.setEditorRevision = setEditorRevision;
      this.editorTop = editorTop;
      this.setEditorTop = setEditorTop;
      this.editorModified = editorModified;
      this.setEditorModified = setEditorModified;
      this.editorReadOnly = editorReadOnly;
      this.setEditorReadOnly = setEditorReadOnly;
      this.editorMessage = editorMessage;
      this.setEditorMessage = setEditorMessage;
      this.visibleFiles = visibleFiles;
      this.editorRows = editorRows;
      this.editorLines = editorLines;
      this.editorCursor = editorCursor;
      this.projection = projection;

      return dispose;
    });
  }

  get hasBuffer(): boolean {
    return this.#buffer !== null;
  }
  get preFilterPath(): string | null {
    return this.#preFilterPath;
  }
  set preFilterPath(value: string | null) {
    this.#preFilterPath = value;
  }
  get pendingSelectionPath(): string | null {
    return this.#pendingSelectionPath;
  }
  set pendingSelectionPath(value: string | null) {
    this.#pendingSelectionPath = value;
  }
  listWidth(): number {
    return filesListWidth(this.#host.width());
  }
  hitTest(x: number, y: number) {
    return filesHitTest(this.projection(), x, y);
  }
  selectedNode(): FileNode | null {
    return this.visibleFiles()[this.fileSelection()]?.node ?? null;
  }
  selectedPath(): string | null {
    return this.selectedNode()?.path ?? null;
  }
  editorWritable(): boolean {
    return Boolean(this.#buffer && !this.editorReadOnly());
  }

  openEditor(rawPath: string, line?: number, origin: EditorOpenOrigin = "user"): void {
    const path = rawPath.startsWith("~/")
      ? `${process.env.HOME ?? ""}${rawPath.slice(1)}`
      : rawPath;
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(path);
    } catch (error) {
      this.setEditorMessage(`cannot open: ${(error as Error).message}`);
      return;
    }
    const reason = classifyFile(bytes.length, isBinary(bytes));
    const text =
      reason === "binary" ? sanitizeForDisplay(bytes) : Buffer.from(bytes).toString("utf8");
    this.#buffer?.destroy();
    this.#buffer = EditBuffer.create("wcwidth");
    this.#buffer.setText(text);
    this.#buffer.setCursor(0, 0);
    let top = 0;
    if (line !== undefined) {
      const target = Math.max(0, Math.min(line, text.split("\n").length - 1));
      this.#buffer.setCursor(target, 0);
      top = scrollToCursor(target, 0, this.editorRows(), text.split("\n").length);
    }
    if (this.#host.mode() !== "editor")
      this.#previousMode = this.#host.mode() === "mirror" ? "mirror" : "home";
    this.setEditorPath(path);
    this.setEditorReadOnly(reason);
    this.setEditorModified(false);
    this.setEditorTop(top);
    this.setEditorMessage("");
    this.setEditorRevision((value) => value + 1);
    this.setFocus("editor");
    if (shouldActivateFilesAfterEditorOpen(this.#host.activePanel(), origin))
      this.#host.activateFiles();
  }

  toggleEditor(): void {
    if (!this.#buffer) return;
    if (this.#host.mode() === "editor") this.#host.leaveFiles(this.#previousMode);
    else {
      this.#previousMode = this.#host.mode() === "mirror" ? "mirror" : "home";
      this.#host.activateFiles();
    }
  }

  save(): void {
    const path = this.editorPath();
    if (!this.#buffer || !path || this.editorReadOnly()) return;
    try {
      const temporary = `${path}.zz-tmp-${process.pid}`;
      writeFileSync(temporary, this.#buffer.getText());
      renameSync(temporary, path);
      this.setEditorModified(false);
      this.setEditorMessage("saved");
    } catch (error) {
      this.setEditorMessage(`save failed: ${(error as Error).message}`);
    }
  }

  syncScroll(): void {
    if (!this.#buffer) return;
    const cursor = this.#buffer.getCursorPosition();
    this.setEditorTop((top) =>
      scrollToCursor(cursor.row, top, this.editorRows(), this.editorLines().length),
    );
  }

  key(event: FilesKeyEvent): void {
    const buffer = this.#buffer;
    if (!buffer) return;
    const readOnly = this.editorReadOnly() !== null;
    const name = event.name;
    if (name === "up") buffer.moveCursorUp();
    else if (name === "down") buffer.moveCursorDown();
    else if (name === "left") buffer.moveCursorLeft();
    else if (name === "right") buffer.moveCursorRight();
    else if (name === "home") buffer.setCursor(buffer.getCursorPosition().row, 0);
    else if (name === "end") buffer.setCursorByOffset(buffer.getEOL().offset);
    else if (name === "pageup") for (let i = 0; i < this.editorRows(); i++) buffer.moveCursorUp();
    else if (name === "pagedown")
      for (let i = 0; i < this.editorRows(); i++) buffer.moveCursorDown();
    else if (!readOnly && name === "return") {
      buffer.newLine();
      this.setEditorModified(true);
    } else if (!readOnly && name === "backspace") {
      buffer.deleteCharBackward();
      this.setEditorModified(true);
    } else if (!readOnly && name === "delete") {
      buffer.deleteChar();
      this.setEditorModified(true);
    } else if (!readOnly && name === "space" && !event.ctrl && !event.meta) {
      buffer.insertText(" ");
      this.setEditorModified(true);
    } else if (!readOnly && name.length === 1 && !event.ctrl && !event.meta) {
      buffer.insertText(event.shift ? name.toUpperCase() : name);
      this.setEditorModified(true);
    } else return;
    this.syncScroll();
    this.setEditorRevision((value) => value + 1);
  }

  insertText(text: string): boolean {
    if (!this.#buffer) return false;
    this.#buffer.insertText(text);
    this.setEditorModified(true);
    this.syncScroll();
    this.setEditorRevision((value) => value + 1);
    return true;
  }
  undo(): void {
    this.#buffer?.undo();
    this.syncScroll();
    this.setEditorRevision((v) => v + 1);
  }
  redo(): void {
    this.#buffer?.redo();
    this.syncScroll();
    this.setEditorRevision((v) => v + 1);
  }
  setCursor(line: number, column: number): void {
    this.#buffer?.setCursor(line, column);
    this.setEditorRevision((v) => v + 1);
  }
  editorCell(cx: number, contentY: number): { line: number; col: number } {
    return clickToCursor({
      cx,
      contentY,
      gutterW: gutterWidth(this.editorLines().length),
      top: this.editorTop(),
      lines: this.editorLines(),
    });
  }

  async listDir(dir: string): Promise<RawEntry[]> {
    const root = this.#host.workspaceDir();
    if (this.#ignoreDir !== root) {
      const matcher = ignore();
      try {
        matcher.add(await readFile(join(root, ".gitignore"), "utf8"));
      } catch {
        // A workspace without .gitignore has no additional ignore rules.
      }
      this.#ignore = matcher;
      this.#ignoreDir = root;
    }
    const entries = await readdir(dir, { withFileTypes: true });
    return filterEntries(
      entries.map((entry) => {
        const directory = entry.isDirectory();
        const relative = relPath(root, join(dir, entry.name));
        let ignored = false;
        try {
          ignored = Boolean(
            relative && this.#ignore.ignores(directory ? `${relative}/` : relative),
          );
        } catch {
          // Invalid ignore input is treated as visible, matching the prior root behavior.
        }
        return { name: entry.name, isDir: directory, ignored };
      }),
      { showHidden: this.showHidden(), showIgnored: this.showIgnored() },
    );
  }

  toggleHidden(): void {
    this.setShowHidden((value) => !value);
    this.#host.refresh();
  }
  toggleIgnored(): void {
    this.setShowIgnored((value) => !value);
    this.#host.refresh();
  }
  moveSelection(delta: number): void {
    const rows = this.visibleFiles();
    if (!rows.length) return;
    const index = Math.max(0, Math.min(rows.length - 1, this.fileSelection() + delta));
    this.setFileSelection(index);
    this.setFileTop((top) => scrollToCursor(index, top, this.editorRows(), rows.length));
  }
  activate(index: number): void {
    const row = this.visibleFiles()[index];
    if (!row) return;
    this.setFileSelection(index);
    if (!row.node.isDir) return this.openEditor(row.node.path);
    if (row.node.expanded) {
      this.setFileNodes((nodes) => removeSubtreeAt(nodes, indexOfPath(nodes, row.node.path)));
      return;
    }
    void this.listDir(row.node.path)
      .then((entries) => {
        const children = buildNodes(row.node.path, entries, row.node.depth + 1);
        this.setFileNodes((nodes) =>
          insertChildrenAt(nodes, indexOfPath(nodes, row.node.path), children),
        );
      })
      .catch(() => undefined);
  }
  async reveal(path: string): Promise<void> {
    const root = this.#host.workspaceDir();
    const relative = relPath(root, path);
    if (!relative) return;
    for (const ancestor of ancestorDirs(relative)) {
      const absolute = join(root, ancestor);
      const node = this.fileNodes()[indexOfPath(this.fileNodes(), absolute)];
      if (!node?.isDir) return;
      if (!node.expanded) {
        const entries = await this.listDir(absolute).catch(() => null);
        if (!entries) return;
        this.setFileNodes((nodes) =>
          insertChildrenAt(
            nodes,
            indexOfPath(nodes, absolute),
            buildNodes(absolute, entries, node.depth + 1),
          ),
        );
      }
    }
    const index = indexOfPath(this.fileNodes(), path);
    if (index < 0) return;
    this.setFileSelection(index);
    this.setFileTop((top) =>
      scrollToCursor(index, top, this.editorRows(), this.visibleFiles().length),
    );
  }
  hopChanged(direction: 1 | -1): void {
    const top = this.gitTop();
    const walk = changedFileWalk(this.statusEntries(), { showHidden: this.showHidden() });
    if (!top || !walk.length) return;
    if (this.query() !== null) this.setQuery(null);
    const selected = this.selectedNode();
    const next = nextChangedPath(
      walk,
      selected ? relPath(top, selected.path) || null : null,
      direction,
    );
    if (next) void this.reveal(join(top, next));
  }

  beginFilter(): void {
    this.#preFilterPath = this.selectedPath();
    this.setQuery("");
    this.setFileSelection(0);
    this.setFileTop(0);
  }

  cancelFilter(): void {
    this.setQuery(null);
    const previous = this.#preFilterPath ? indexOfPath(this.fileNodes(), this.#preFilterPath) : -1;
    const index = previous === -1 ? 0 : previous;
    this.setFileSelection(index);
    this.setFileTop((top) =>
      scrollToCursor(index, top, this.editorRows(), this.visibleFiles().length),
    );
  }

  confirmFilter(): void {
    const row = this.visibleFiles()[this.fileSelection()];
    this.setQuery(null);
    if (!row) return;
    const index = indexOfPath(this.fileNodes(), row.node.path);
    if (index === -1) return;
    this.setFileSelection(index);
    this.setFileTop((top) =>
      scrollToCursor(index, top, this.editorRows(), this.visibleFiles().length),
    );
    this.activate(index);
  }

  applyCatalog(envelope: WorkspaceFilesCatalogEnvelopeV1): void {
    const resource = envelope.resource;
    if (resource.status !== "ready") {
      this.setFileNodes([]);
      this.setEditorMessage(resource.message);
      return;
    }
    const root = this.#host.workspaceDir();
    const entries = resource.entries.filter(
      (entry) => (this.showHidden() || !entry.hidden) && (this.showIgnored() || !entry.ignored),
    );
    this.setFileNodes(
      entries.map((entry) => ({
        name: entry.name,
        path: join(root, entry.relativePath),
        isDir: entry.kind === "directory",
        depth: 0,
        expanded: false,
        ignored: entry.ignored,
      })),
    );
    this.setGitTop(root);
    this.setStatusEntries(
      entries.flatMap((entry) =>
        entry.gitStatus
          ? [{ status: statusLetter(entry.gitStatus), path: entry.relativePath, staged: false }]
          : [],
      ),
    );
    this.setFileSelection((current) =>
      Math.max(0, Math.min(Math.max(0, entries.length - 1), current)),
    );
    if (this.#pendingSelectionPath) {
      const path = this.#pendingSelectionPath;
      this.#pendingSelectionPath = null;
      void this.reveal(path);
    }
  }

  resetCatalog(): void {
    this.setFileNodes([]);
    this.setStatusEntries([]);
    this.setGitTop(null);
  }

  action(id: FilesActionId): void {
    if (id === "save") this.save();
    else if (id === "reload") {
      const path = this.editorPath();
      if (path) this.openEditor(path);
    } else if (id === "filter") this.beginFilter();
    else if (id === "toggle-hidden") this.toggleHidden();
    else if (id === "toggle-ignored") this.toggleIgnored();
    else if (id === "refresh") this.#host.refresh();
  }
  async create(parent: string, name: string): Promise<void> {
    await writeFile(join(parent, name), "", { flag: "wx" });
    this.#host.note(`created ${name}`);
    this.#host.refresh();
  }
  async rename(path: string, name: string): Promise<void> {
    await rename(path, join(dirname(path), name));
    this.#host.note(`renamed → ${name}`);
    this.#host.refresh();
  }
  async delete(path: string): Promise<void> {
    await rm(path, { recursive: true, force: false });
    this.#host.note(`deleted ${basename(path)}`);
    this.#host.refresh();
  }
  dispose(): void {
    this.#buffer?.destroy();
    this.#buffer = null;
    this.#disposeReactiveOwner();
  }
}

export const createFilesFeatureSession = (host: FilesFeatureHost): FilesFeatureSession =>
  new FilesFeatureSession(host);
