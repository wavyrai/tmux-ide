import {
  readEditorFile,
  saveEditorFile,
  boundEditorText,
  MAX_EDITOR_LINES,
} from "./editor-file-io.ts";
import { EditBuffer } from "@opentui/core";
import type { WorkspaceFilesCatalogEnvelopeV1 } from "@tmux-ide/contracts";
import ignore, { type Ignore } from "ignore";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createMemo, createRoot, createSignal, type Accessor, type Setter } from "solid-js";

import type { StatusEntry } from "../../diff-model.ts";
import { MAX_EDITABLE_BYTES, readOnlyBanner, type ReadOnlyReason } from "../../editor-buffer.ts";
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
  readonly workspaceName: () => string;
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

export interface FilesFeatureIO {
  readonly readEditorFile?: typeof readEditorFile;
  readonly saveEditorFile?: typeof saveEditorFile;
  readonly readFile: typeof readFile;
  readonly readdir: typeof readdir;
  readonly writeFile: typeof writeFile;
  readonly rename: typeof rename;
  readonly rm: typeof rm;
}

const defaultFilesFeatureIO: FilesFeatureIO = { readFile, readdir, writeFile, rename, rm };

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
  readonly #io: FilesFeatureIO;
  #buffer: EditBuffer | null = null;
  #loadController: AbortController | null = null;
  #loadRequest = 0;
  #contentVersion = 0;
  #editorByteLength = 0;
  #loadedPath: string | null = null;
  #saveController: AbortController | null = null;
  #saveFlight: Promise<void> | null = null;
  #pendingSave: {
    buffer: EditBuffer;
    path: string;
    text: string;
    version: number;
    epoch: number;
    root: string;
    identity: string;
  } | null = null;
  #epoch = 0;
  #workspaceIdentity = "";
  #disposed = false;
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

  constructor(host: FilesFeatureHost, io: FilesFeatureIO = defaultFilesFeatureIO) {
    this.#host = host;
    this.#io = io;
    this.#workspaceIdentity = this.#identity();
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
      let projectedContentVersion = -1;
      let projectedLines = [""];
      const editorLines = createMemo(() => {
        editorRevision();
        if (projectedContentVersion !== this.#contentVersion) {
          const text = this.#buffer?.getText() ?? "";
          this.#editorByteLength = Buffer.byteLength(text);
          projectedLines = text.split("\n");
          projectedContentVersion = this.#contentVersion;
        }
        return projectedLines;
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

  #identity(): string {
    return `${this.#host.workspaceName()}\u0000${this.#host.workspaceDir()}`;
  }

  #captureEpoch(): { readonly epoch: number; readonly root: string; readonly identity: string } {
    if (this.#disposed) {
      return {
        epoch: this.#epoch,
        root: this.#host.workspaceDir(),
        identity: this.#identity(),
      };
    }
    const identity = this.#identity();
    if (identity !== this.#workspaceIdentity) {
      this.#workspaceIdentity = identity;
      this.#epoch += 1;
      this.#loadController?.abort();
      this.#saveController?.abort();
      this.#pendingSave = null;
      this.#buffer?.destroy();
      this.#buffer = null;
      this.#loadedPath = null;
      this.#contentVersion++;
      this.setEditorPath(null);
      this.setEditorModified(false);
      this.setEditorReadOnly(null);
      this.setEditorMessage("");
      this.setEditorRevision((value) => value + 1);
      this.resetCatalog();
    }
    return { epoch: this.#epoch, root: this.#host.workspaceDir(), identity };
  }

  #isCurrent(epoch: number, root: string, identity: string): boolean {
    return (
      !this.#disposed &&
      epoch === this.#epoch &&
      root === this.#host.workspaceDir() &&
      identity === this.#identity()
    );
  }

  async openEditor(
    rawPath: string,
    line?: number,
    origin: EditorOpenOrigin = "user",
  ): Promise<void> {
    if (this.#disposed) return;
    const { epoch, root, identity } = this.#captureEpoch();
    this.#loadController?.abort();
    const controller = new AbortController();
    this.#loadController = controller;
    const request = ++this.#loadRequest;
    const contentVersion = this.#contentVersion;
    const path = rawPath.startsWith("~/")
      ? `${process.env.HOME ?? ""}${rawPath.slice(1)}`
      : rawPath;
    const current = () =>
      request === this.#loadRequest &&
      !controller.signal.aborted &&
      this.#isCurrent(epoch, root, identity);
    this.setEditorMessage("loading…");
    try {
      const loaded = await (this.#io.readEditorFile ?? readEditorFile)(path, controller.signal);
      if (!current()) return;
      // Navigation/reload intentionally replaces earlier edits, but never edits
      // entered while this asynchronous load was pending.
      if (contentVersion !== this.#contentVersion) {
        this.setEditorMessage("open cancelled: current buffer changed while loading");
        return;
      }
      const next = EditBuffer.create("wcwidth");
      try {
        next.setText(loaded.text);
        next.setCursor(0, 0);
      } catch (error) {
        next.destroy();
        throw error;
      }
      this.#saveController?.abort();
      this.#pendingSave = null;
      this.#buffer?.destroy();
      this.#buffer = next;
      this.#loadedPath = loaded.path;
      this.#contentVersion++;
      let top = 0;
      if (line !== undefined) {
        const target = Math.max(0, Math.min(line, loaded.lineCount - 1));
        next.setCursor(target, 0);
        top = scrollToCursor(target, 0, this.editorRows(), loaded.lineCount);
      }
      if (this.#host.mode() !== "editor")
        this.#previousMode = this.#host.mode() === "mirror" ? "mirror" : "home";
      this.setEditorPath(path);
      this.setEditorReadOnly(loaded.reason);
      this.setEditorModified(false);
      this.setEditorTop(top);
      this.setEditorMessage(loaded.truncated ? "truncated preview · read-only" : "");
      this.setEditorRevision((value) => value + 1);
      this.setFocus("editor");
      if (shouldActivateFilesAfterEditorOpen(this.#host.activePanel(), origin))
        this.#host.activateFiles();
    } catch (error) {
      if (current()) this.setEditorMessage(`cannot open: ${(error as Error).message}`);
    } finally {
      if (this.#loadController === controller) this.#loadController = null;
    }
  }

  toggleEditor(): void {
    if (!this.#buffer) return;
    if (this.#host.mode() === "editor") this.#host.leaveFiles(this.#previousMode);
    else {
      this.#previousMode = this.#host.mode() === "mirror" ? "mirror" : "home";
      this.#host.activateFiles();
    }
  }

  save(): Promise<void> {
    const scope = this.#captureEpoch();
    if (this.#disposed || !this.#buffer || !this.#loadedPath || this.editorReadOnly())
      return Promise.resolve();
    // At most one in-flight snapshot and one latest explicitly requested snapshot.
    this.#pendingSave = {
      ...scope,
      buffer: this.#buffer,
      path: this.#loadedPath,
      text: this.#buffer.getText(),
      version: this.#contentVersion,
    };
    if (this.#saveFlight) return this.#saveFlight;
    // Admission is installed before draining starts. Recheck after each awaited
    // drain; clear admission in the same turn as the final empty check.
    this.#saveFlight = Promise.resolve().then(async () => {
      try {
        do {
          await this.#saveSerial();
        } while (this.#pendingSave && !this.#disposed);
      } finally {
        this.#saveFlight = null;
      }
    });
    return this.#saveFlight;
  }

  async #saveSerial(): Promise<void> {
    while (this.#pendingSave && !this.#disposed) {
      const { buffer, path, text, version, epoch, root, identity } = this.#pendingSave;
      this.#pendingSave = null;
      const current = () => this.#buffer === buffer && this.#isCurrent(epoch, root, identity);
      if (!current()) continue;
      const controller = new AbortController();
      this.#saveController = controller;
      try {
        await (this.#io.saveEditorFile ?? saveEditorFile)(path, text, controller.signal, current);
        if (current() && !controller.signal.aborted) {
          this.setEditorModified(this.#contentVersion !== version);
          this.setEditorMessage(
            this.#contentVersion === version
              ? "saved"
              : "saved snapshot; newer edits remain unsaved",
          );
        }
      } catch (error) {
        if (current() && !controller.signal.aborted)
          this.setEditorMessage(`save failed: ${(error as Error).message}`);
      } finally {
        if (this.#saveController === controller) this.#saveController = null;
      }
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
      if (!this.#canInsert("\n")) return;
      buffer.newLine();
      this.#contentVersion++;
      this.setEditorModified(true);
    } else if (!readOnly && name === "backspace") {
      buffer.deleteCharBackward();
      this.#contentVersion++;
      this.setEditorModified(true);
    } else if (!readOnly && name === "delete") {
      buffer.deleteChar();
      this.#contentVersion++;
      this.setEditorModified(true);
    } else if (!readOnly && name === "space" && !event.ctrl && !event.meta) {
      if (!this.#canInsert(" ")) return;
      buffer.insertText(" ");
      this.#contentVersion++;
      this.setEditorModified(true);
    } else if (!readOnly && name.length === 1 && !event.ctrl && !event.meta) {
      const text = event.shift ? name.toUpperCase() : name;
      if (!this.#canInsert(text)) return;
      buffer.insertText(text);
      this.#contentVersion++;
      this.setEditorModified(true);
    } else return;
    this.setEditorRevision((value) => value + 1);
    this.syncScroll();
  }

  #canInsert(text: string): boolean {
    if (!this.#buffer) return false;
    const lines = this.editorLines();
    const added = boundEditorText(text);
    const lineCount = lines.length + added.lineCount - 1;
    if (
      this.#editorByteLength + Buffer.byteLength(text) >= MAX_EDITABLE_BYTES ||
      lineCount > MAX_EDITOR_LINES ||
      added.truncated
    ) {
      this.setEditorMessage("edit exceeds editor size limit");
      return false;
    }
    return true;
  }

  insertText(text: string): boolean {
    if (!this.editorWritable() || !this.#buffer || !this.#canInsert(text)) return false;
    this.#buffer.insertText(text);
    this.#contentVersion++;
    this.setEditorModified(true);
    this.setEditorRevision((value) => value + 1);
    this.syncScroll();
    return true;
  }
  undo(): void {
    if (!this.editorWritable() || !this.#buffer?.canUndo()) return;
    this.#contentVersion++;
    this.setEditorModified(true);
    this.#buffer.undo();
    this.setEditorRevision((v) => v + 1);
    this.syncScroll();
  }
  redo(): void {
    if (!this.editorWritable() || !this.#buffer?.canRedo()) return;
    this.#contentVersion++;
    this.setEditorModified(true);
    this.#buffer.redo();
    this.setEditorRevision((v) => v + 1);
    this.syncScroll();
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
    if (this.#disposed) return [];
    const { epoch, root, identity } = this.#captureEpoch();
    const matcher: Ignore = ignore();
    try {
      matcher.add(await this.#io.readFile(join(root, ".gitignore"), "utf8"));
    } catch {
      // A workspace without .gitignore has no additional ignore rules.
    }
    const entries = await this.#io.readdir(dir, { withFileTypes: true });
    if (!this.#isCurrent(epoch, root, identity)) return [];
    return filterEntries(
      entries.map((entry) => {
        const directory = entry.isDirectory();
        const relative = relPath(root, join(dir, entry.name));
        let ignored = false;
        try {
          ignored = Boolean(relative && matcher.ignores(directory ? `${relative}/` : relative));
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
    if (this.#disposed) return;
    const row = this.visibleFiles()[index];
    if (!row) return;
    this.setFileSelection(index);
    if (!row.node.isDir) {
      void this.openEditor(row.node.path);
      return;
    }
    if (row.node.expanded) {
      this.setFileNodes((nodes) => removeSubtreeAt(nodes, indexOfPath(nodes, row.node.path)));
      return;
    }
    const { epoch, root, identity } = this.#captureEpoch();
    void this.listDir(row.node.path)
      .then((entries) => {
        if (!this.#isCurrent(epoch, root, identity)) return;
        const children = buildNodes(row.node.path, entries, row.node.depth + 1);
        this.setFileNodes((nodes) =>
          insertChildrenAt(nodes, indexOfPath(nodes, row.node.path), children),
        );
      })
      .catch(() => undefined);
  }
  async reveal(path: string): Promise<void> {
    if (this.#disposed) return;
    const { epoch, root, identity } = this.#captureEpoch();
    const relative = relPath(root, path);
    if (!relative) return;
    for (const ancestor of ancestorDirs(relative)) {
      const absolute = join(root, ancestor);
      const node = this.fileNodes()[indexOfPath(this.fileNodes(), absolute)];
      if (!node?.isDir) return;
      if (!node.expanded) {
        const entries = await this.listDir(absolute).catch(() => null);
        if (!entries || !this.#isCurrent(epoch, root, identity)) return;
        this.setFileNodes((nodes) =>
          insertChildrenAt(
            nodes,
            indexOfPath(nodes, absolute),
            buildNodes(absolute, entries, node.depth + 1),
          ),
        );
      }
    }
    if (!this.#isCurrent(epoch, root, identity)) return;
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
    const { root } = this.#captureEpoch();
    if (this.#disposed || resource.workspaceName !== this.#host.workspaceName()) return;
    if (resource.status !== "ready") {
      this.setFileNodes([]);
      this.setEditorMessage(resource.message);
      return;
    }
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
    if (id === "save") void this.save();
    else if (id === "reload") {
      const path = this.editorPath();
      if (path) void this.openEditor(path);
    } else if (id === "filter") this.beginFilter();
    else if (id === "toggle-hidden") this.toggleHidden();
    else if (id === "toggle-ignored") this.toggleIgnored();
    else if (id === "refresh") this.#host.refresh();
  }
  async create(parent: string, name: string): Promise<void> {
    if (this.#disposed) return;
    const { epoch, root, identity } = this.#captureEpoch();
    await this.#io.writeFile(join(parent, name), "", { flag: "wx" });
    if (!this.#isCurrent(epoch, root, identity)) return;
    this.#host.note(`created ${name}`);
    this.#host.refresh();
  }
  async rename(path: string, name: string): Promise<void> {
    if (this.#disposed) return;
    const { epoch, root, identity } = this.#captureEpoch();
    await this.#io.rename(path, join(dirname(path), name));
    if (!this.#isCurrent(epoch, root, identity)) return;
    this.#host.note(`renamed → ${name}`);
    this.#host.refresh();
  }
  async delete(path: string): Promise<void> {
    if (this.#disposed) return;
    const { epoch, root, identity } = this.#captureEpoch();
    await this.#io.rm(path, { recursive: true, force: false });
    if (!this.#isCurrent(epoch, root, identity)) return;
    this.#host.note(`deleted ${basename(path)}`);
    this.#host.refresh();
  }
  dispose(): void {
    this.#disposed = true;
    this.#loadController?.abort();
    this.#saveController?.abort();
    this.#loadRequest++;
    this.#pendingSave = null;
    this.#epoch += 1;
    this.#buffer?.destroy();
    this.#buffer = null;
    this.#disposeReactiveOwner();
  }
}

export const createFilesFeatureSession = (
  host: FilesFeatureHost,
  io?: FilesFeatureIO,
): FilesFeatureSession => new FilesFeatureSession(host, io);
