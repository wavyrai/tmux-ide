import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  NativeJournalUint64SchemaZ,
  WindowLinkTargetSchemaZ,
  WindowSplitLayoutResourceSchemaZ,
  WindowSplitResizeTargetSchemaZ,
  type WindowLinkTarget,
  type WindowSplitLayoutResource,
  type WindowSplitResizeTarget,
} from "@tmux-ide/contracts";
import { supportsNativeSessionGuard } from "../../lib/native-operation-command.ts";
import type { NativeSplitResizeRequest } from "../protocol/native-split-resize.ts";
import { parseLayoutTree, type LayoutTreeNode } from "../protocol/layout-parse.ts";
import type { NativeSplitLayoutSnapshot } from "./session-channel.ts";

const MAX_RETAINED_WINDOWS = 32;
interface SnapshotRecord {
  readonly resource: WindowSplitLayoutResource;
  readonly identity: string;
  readonly snapshot: NativeSplitLayoutSnapshot;
  readonly serverEpoch: string;
  readonly paths: ReadonlyMap<string, readonly number[]>;
}
export class WindowSplitLayoutUnavailable extends Error {
  constructor() {
    super("Window split layout is unavailable or stale");
    this.name = "WindowSplitLayoutUnavailable";
  }
}

/** Bounded, opt-in handles for one canonical channel. A handle is not permission:
 * the transport and owner must still authorize geometry and guard native effects.
 * No raw tmux IDs, native layout strings or child paths enter the public resource.
 * Re-read canonical state at resolution; native exact-layout guards cover changes
 * not yet observed by the channel. Dispose this authority with its channel. */
export class WindowSplitAuthority {
  readonly #records = new Map<string, SnapshotRecord>();
  #disposed = false;
  constructor(
    private readonly options: {
      describe(window: WindowLinkTarget): NativeSplitLayoutSnapshot;
      serverEpoch(): string | null;
    },
  ) {}

  #capture(window: WindowLinkTarget) {
    if (this.#disposed) throw new WindowSplitLayoutUnavailable();
    const serverEpoch = z.uuid().parse(this.options.serverEpoch());
    const snapshot = structuredClone(this.options.describe(window));
    if (
      snapshot.semanticWindowId !== window.expectedSemanticWindowId ||
      !/^@(0|[1-9][0-9]{0,9})$/u.test(snapshot.runtimeWindowId) ||
      Number(snapshot.runtimeWindowId.slice(1)) > 0xffffffff ||
      !supportsNativeSessionGuard({
        id: snapshot.runtimeSessionId,
        name: snapshot.sessionName,
        created: snapshot.sessionCreated,
      })
    )
      throw new WindowSplitLayoutUnavailable();
    const tree = parseLayoutTree(snapshot.rawLayout);
    if (!tree || tree.width > 4096 || tree.height > 4096 || snapshot.panes.length > 256)
      throw new WindowSplitLayoutUnavailable();
    snapshot.panes.forEach((pane) => {
      if (
        !/^%(0|[1-9][0-9]{0,9})$/u.test(pane.runtimePaneId) ||
        Number(pane.runtimePaneId.slice(1)) > 0xffffffff ||
        !NativeJournalUint64SchemaZ.refine((birth) => birth !== "0").safeParse(
          pane.nativePaneBirthId,
        ).success
      )
        throw new WindowSplitLayoutUnavailable();
    });
    const mapping = new Map(snapshot.panes.map((pane) => [pane.runtimePaneId, pane]));
    if (mapping.size !== snapshot.panes.length) throw new WindowSplitLayoutUnavailable();
    const panes: WindowSplitLayoutResource["panes"] = [];
    const paths = new Map<string, readonly number[]>();
    const splits: WindowSplitLayoutResource["splits"] = [];
    let nativeSerializationBudget = 5;
    const visit = (node: LayoutTreeNode, path: readonly number[]) => {
      nativeSerializationBudget += 21;
      if (node.kind === "leaf") {
        nativeSerializationBudget += node.id.length - 1;
        const pane = mapping.get(node.id);
        if (!pane) throw new WindowSplitLayoutUnavailable();
        panes.push({
          semanticPaneId: pane.semanticPaneId,
          left: node.left,
          top: node.top,
          width: node.width,
          height: node.height,
        });
        return;
      }
      node.children.forEach((child, index) => {
        const childPath = [...path, index];
        if (index < node.children.length - 1) {
          const splitId = randomUUID();
          paths.set(splitId, childPath);
          splits.push({
            splitId,
            axis: node.axis,
            boundary: node.axis === "cols" ? child.left + child.width : child.top + child.height,
            start: node.axis === "cols" ? node.top : node.left,
            length: node.axis === "cols" ? node.height : node.width,
          });
        }
        visit(child, childPath);
      });
    };
    visit(tree, []);
    if (panes.length !== mapping.size || nativeSerializationBudget > 8192)
      throw new WindowSplitLayoutUnavailable();
    const resource = WindowSplitLayoutResourceSchemaZ.parse({
      version: 1,
      window,
      layoutId: randomUUID(),
      cols: tree.width,
      rows: tree.height,
      panes,
      splits,
    });
    // Canonical pane order must not retire a valid geometric observation.
    const identity = JSON.stringify({
      window,
      serverEpoch,
      ...snapshot,
      panes: [...snapshot.panes].sort((a, b) => a.runtimePaneId.localeCompare(b.runtimePaneId)),
    });
    return { resource, paths, snapshot, serverEpoch, identity };
  }

  read(rawWindow: WindowLinkTarget): WindowSplitLayoutResource {
    const window = WindowLinkTargetSchemaZ.parse(rawWindow);
    try {
      const current = this.#capture(window);
      const previous = this.#records.get(window.linkId);
      const record = previous?.identity === current.identity ? previous : current;
      this.#records.delete(window.linkId);
      this.#records.set(window.linkId, record);
      while (this.#records.size > MAX_RETAINED_WINDOWS)
        this.#records.delete(this.#records.keys().next().value!);
      return structuredClone(record.resource);
    } catch {
      this.#records.delete(window.linkId);
      throw new WindowSplitLayoutUnavailable();
    }
  }

  resolve(rawTarget: WindowSplitResizeTarget) {
    const target = WindowSplitResizeTargetSchemaZ.parse(rawTarget);
    const record = this.#records.get(target.window.linkId);
    try {
      if (
        !record ||
        record.resource.layoutId !== target.layoutId ||
        JSON.stringify(record.resource.window) !== JSON.stringify(target.window)
      )
        throw new WindowSplitLayoutUnavailable();
      const path = record.paths.get(target.splitId);
      const split = record.resource.splits.find((entry) => entry.splitId === target.splitId);
      if (!path || !split || this.#capture(target.window).identity !== record.identity)
        throw new WindowSplitLayoutUnavailable();
      const anchor = record.snapshot.panes[0]!;
      const request: NativeSplitResizeRequest = {
        sessionId: record.snapshot.runtimeSessionId,
        windowId: record.snapshot.runtimeWindowId,
        expectedLayout: record.snapshot.rawLayout,
        path: [...path],
        axis: split.axis,
        boundary: target.boundary,
      };
      return {
        request,
        serverEpoch: record.serverEpoch,
        session: {
          id: record.snapshot.runtimeSessionId,
          name: record.snapshot.sessionName,
          created: record.snapshot.sessionCreated,
        },
        anchor: { paneId: anchor.runtimePaneId, paneBirthId: anchor.nativePaneBirthId! },
      };
    } catch {
      // An invalid token must not evict another viewer's otherwise live token.
      if (record && record.resource.layoutId === target.layoutId) {
        try {
          if (this.#capture(record.resource.window).identity !== record.identity)
            this.#records.delete(target.window.linkId);
        } catch {
          this.#records.delete(target.window.linkId);
        }
      }
      throw new WindowSplitLayoutUnavailable();
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#records.clear();
  }
}
