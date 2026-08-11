import type {
  SessionRuntimeSemanticIntent,
  WorkspaceMultiplexerMutationResult,
} from "@tmux-ide/contracts";

import { AsyncDisposableSlot } from "../../async-disposable-slot.ts";
import type { CellArrays } from "../blit.ts";
import type { BlitOptions, CursorState } from "../pane-mirror.ts";
import type { TerminalPaneRenderSource } from "../pane-surface.tsx";
import { SemanticSessionView } from "../semantic-session-view.ts";
import { SemanticTerminalRenderSource } from "../semantic-pane-render-source.ts";
import type { TerminalPaletteProjection } from "../theme.ts";
import type { OpenTuiSessionRuntimeLane } from "../application-shell-daemon-runtime.ts";
import type { TuiApplicationLifecycle } from "./application-lifecycle.ts";

export type OpenTuiTerminalRuntimeFactory = () => Promise<OpenTuiSessionRuntimeLane | null>;

/** Stable facade retained by PaneSurface renderables across runtime reconnects. */
class RetainedTerminalRenderSource implements TerminalPaneRenderSource {
  #source: SemanticTerminalRenderSource | null = null;

  setSource(source: SemanticTerminalRenderSource | null): void {
    this.#source = source;
  }

  scrollbackDepth(paneId: string): number {
    return this.#source?.scrollbackDepth(paneId) ?? 0;
  }

  cursorState(paneId: string): CursorState | null {
    return this.#source?.cursorState(paneId) ?? null;
  }

  blitPane(
    paneId: string,
    buffers: CellArrays,
    width: number,
    height: number,
    scrollOffset: number,
    defaultFg: number,
    defaultBg: number,
    options: BlitOptions,
  ): void {
    this.#source?.blitPane(
      paneId,
      buffers,
      width,
      height,
      scrollOffset,
      defaultFg,
      defaultBg,
      options,
    );
  }

  releasePane(paneId: string, consumerId: object): void {
    this.#source?.releasePane(paneId, consumerId);
  }
}

/**
 * Root adapter around the terminal semantic fast lane. Runtime replacements do
 * not replace either the SessionView or the framebuffer render-source object.
 */
export class OpenTuiTerminalWorkspaceAdapter {
  readonly view: SemanticSessionView;
  readonly renderSource: TerminalPaneRenderSource;
  readonly #retainedSource = new RetainedTerminalRenderSource();
  readonly #emptySource = new SemanticTerminalRenderSource();
  readonly #slot = new AsyncDisposableSlot<string>();
  readonly #lifecycle: TuiApplicationLifecycle;
  #lane: OpenTuiSessionRuntimeLane | null = null;
  #generation = 0;
  #renderEpoch = 0;
  #disposed = false;

  constructor(options: {
    readonly target: string;
    readonly lifecycle: TuiApplicationLifecycle;
    readonly onDirty?: () => void;
    readonly onFocusChanged?: (paneId: string, source: "local" | "tmux") => void;
    readonly onStatus?: (message: string) => void;
    readonly onExit?: () => void;
  }) {
    this.#lifecycle = options.lifecycle;
    this.view = new SemanticSessionView(options);
    this.renderSource = this.#retainedSource;
    this.view.setSource(this.#emptySource);
  }

  get lane(): OpenTuiSessionRuntimeLane | null {
    return this.#lane;
  }

  /** Bumps whenever the retained facade adopts or retires a backing source. */
  get renderEpoch(): number {
    return this.#renderEpoch;
  }

  connect(
    key: string,
    create: OpenTuiTerminalRuntimeFactory,
  ): Promise<OpenTuiSessionRuntimeLane | null> {
    if (this.#disposed || !this.#lifecycle.accepting) return Promise.resolve(null);
    if (this.#slot.key === key) return Promise.resolve(this.#lane);
    const generation = ++this.#generation;
    let resolveConnection!: (lane: OpenTuiSessionRuntimeLane | null) => void;
    const connection = new Promise<OpenTuiSessionRuntimeLane | null>((resolve) => {
      resolveConnection = resolve;
    });
    this.#slot.ensure(key, async () => {
      let lane: OpenTuiSessionRuntimeLane | null;
      try {
        lane = await create();
      } catch (error) {
        resolveConnection(null);
        throw error;
      }
      if (!lane) {
        resolveConnection(null);
        throw new Error(`Terminal runtime ${key} is unavailable`);
      }
      if (this.#disposed || !this.#lifecycle.accepting || generation !== this.#generation) {
        lane.close();
        resolveConnection(null);
        return () => {};
      }
      this.#lane = lane;
      this.#renderEpoch += 1;
      this.#retainedSource.setSource(lane.source);
      this.view.setSource(lane.source);
      resolveConnection(lane);
      return () => {
        if (this.#lane === lane) {
          this.#lane = null;
          this.#renderEpoch += 1;
          this.#retainedSource.setSource(null);
          this.view.setSource(this.#emptySource);
        }
        lane.close();
      };
    });
    return connection;
  }

  sendText(paneId: string, text: string): boolean {
    const lane = this.#lane;
    if (!this.#lifecycle.accepting || !lane?.ownsInput) return false;
    lane.sendText(paneId, text);
    return true;
  }

  sendKey(paneId: string, key: string): boolean {
    const lane = this.#lane;
    if (!this.#lifecycle.accepting || !lane?.ownsInput) return false;
    lane.sendKey(paneId, key);
    return true;
  }

  fitViewport(cols: number, rows: number): Promise<void> | null {
    const lane = this.#lane;
    if (!this.#lifecycle.accepting || !lane?.ownsGeometry) return null;
    return lane.fitViewport(cols, rows);
  }

  submit(
    intent: SessionRuntimeSemanticIntent,
    operationId?: string,
  ): Promise<WorkspaceMultiplexerMutationResult | null> | null {
    const lane = this.#lane;
    if (!this.#lifecycle.accepting || !lane?.ownsInput) return null;
    return lane.submit(intent, operationId);
  }

  /** Existing snapshot APIs remain available without crossing the state lane. */
  panes(
    scrollOffsets: ReadonlyMap<string, number>,
    styledRows: boolean,
    palette: TerminalPaletteProjection,
  ) {
    return this.view.panes(scrollOffsets, styledRows, palette);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation += 1;
    this.#slot.dispose();
    this.#lane = null;
    this.#renderEpoch += 1;
    this.#retainedSource.setSource(null);
    this.view.dispose();
  }
}
