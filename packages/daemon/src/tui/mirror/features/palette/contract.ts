import type { PaletteUsageEntry, Tab } from "../../app-state.ts";
import type { AgentRowInput } from "../../agent-rows.ts";
import type { HostedPanelView } from "../../panel-host.ts";
import type { PaletteAction, PalettePaneInput, TmuxBuffer } from "../../palette.ts";
import type { PaletteSaveState, PaletteSurfaceEntry } from "../../palette-surface-adapter.ts";
import type { CommandPaletteProjection } from "../../workspace/command-palette-surface.ts";
import type { MultiplexerVerbFacts, ProductSurfaceId } from "@tmux-ide/contracts";
import type { SettingsCommandId } from "../settings/catalog.ts";

export interface PaletteWorkspaceIdentity {
  readonly workspaceName: string;
  readonly directory: string;
  readonly projectRoot: string;
  readonly daemonIdentity: string;
  readonly generation: number;
}

export function paletteWorkspaceIdentityScope(identity: PaletteWorkspaceIdentity): string {
  return JSON.stringify([
    identity.workspaceName,
    identity.directory,
    identity.projectRoot,
    identity.daemonIdentity,
    identity.generation,
  ]);
}

export type PaletteAsyncState<Value> =
  | { readonly phase: "idle"; readonly value: Value }
  | { readonly phase: "loading"; readonly value: Value }
  | { readonly phase: "ready"; readonly value: Value }
  | { readonly phase: "error"; readonly value: Value; readonly message: string };

export type PaletteHostIntent =
  | { readonly kind: "action"; readonly action: PaletteAction; readonly usageKey: string }
  | { readonly kind: "settings"; readonly command: SettingsCommandId; readonly usageKey: string }
  | { readonly kind: "paste-buffer"; readonly bufferName: string }
  | { readonly kind: "close"; readonly reason: "escape" | "outside" | "action" };

export interface PaletteDynamicFacts {
  readonly terminal: boolean;
  readonly surface: Tab;
  readonly currentSurface: ProductSurfaceId;
  readonly currentViewId: string | null;
  readonly currentSession: string | null;
  readonly sessions: readonly string[];
  readonly agents: readonly AgentRowInput[];
  readonly panes: readonly PalettePaneInput[];
  readonly sizeMismatch: boolean;
  readonly appMousePane: boolean;
  readonly againName: string | null;
  readonly usage: Readonly<Record<string, PaletteUsageEntry>>;
  readonly keycaps: Readonly<Record<string, string>>;
  readonly views: readonly HostedPanelView[];
  readonly syncOn: boolean;
  readonly saveState: PaletteSaveState;
  readonly multiplexerFacts: MultiplexerVerbFacts;
}

export interface PaletteHostPort {
  readonly width: () => number;
  readonly height: () => number;
  readonly identity: () => PaletteWorkspaceIdentity;
  readonly facts: () => PaletteDynamicFacts;
  readonly loadRepoFiles: (
    identity: PaletteWorkspaceIdentity,
    signal: AbortSignal,
  ) => Promise<readonly string[]>;
  readonly loadBuffers: (
    identity: PaletteWorkspaceIdentity,
    signal: AbortSignal,
  ) => Promise<readonly TmuxBuffer[]>;
  readonly dispatch: (intent: PaletteHostIntent) => void | Promise<void>;
  readonly disabledReason?: (action: PaletteAction) => string | null | undefined;
}

export interface PaletteKeyEvent {
  readonly name: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
}

export interface PalettePointerEvent {
  readonly kind: "move" | "down" | "scroll" | "up" | "out";
  readonly x: number;
  readonly y: number;
  readonly button?: number;
  readonly scrollDirection?: "up" | "down";
}

export interface PaletteFeatureSnapshot {
  readonly open: boolean;
  readonly level: "actions" | "buffers";
  readonly query: string;
  readonly selectedCommandId: string | null;
  readonly selectedBufferIndex: number;
  readonly scrollTop: number;
  readonly entries: readonly PaletteSurfaceEntry[];
  readonly projection: CommandPaletteProjection;
  readonly repo: PaletteAsyncState<readonly string[]>;
  readonly buffers: PaletteAsyncState<readonly TmuxBuffer[]>;
}

export interface PaletteFeatureSession {
  readonly open: () => boolean;
  readonly disposed: () => boolean;
  readonly snapshot: () => PaletteFeatureSnapshot;
  readonly projection: () => CommandPaletteProjection;
  readonly entries: () => readonly PaletteSurfaceEntry[];
  readonly openPalette: () => void;
  readonly close: (reason?: "escape" | "outside" | "action") => void;
  readonly openBufferPicker: () => void;
  readonly switchWorkspace: (identity: PaletteWorkspaceIdentity) => void;
  readonly retryRepoFiles: () => void;
  readonly retryBuffers: () => void;
  readonly handleKey: (event: PaletteKeyEvent) => boolean;
  readonly handlePaste: (text: string) => boolean;
  readonly handlePointer: (event: PalettePointerEvent) => boolean;
  readonly dispose: () => void;
}
