import {
  TerminalAttachRequestSchemaZ,
  TerminalAttachmentViewportSchemaZ,
  type TerminalAttachRequest,
  type TerminalAttachmentViewport,
} from "@tmux-ide/contracts";

export type NativeTerminalConnectionState = "connected" | "disconnected";

export interface NativeTerminalGeometry {
  readonly sourceGrid: TerminalAttachmentViewport;
  readonly clientViewport: TerminalAttachmentViewport;
}

export type NativeTerminalEvent =
  | { readonly type: "output"; readonly bytes: Uint8Array }
  | {
      readonly type: "state";
      readonly state: "connected";
      readonly error: null;
      readonly sourceGrid: TerminalAttachmentViewport;
      readonly clientViewport: TerminalAttachmentViewport;
    }
  | {
      readonly type: "geometry";
      readonly sourceGrid: TerminalAttachmentViewport;
      readonly clientViewport: TerminalAttachmentViewport;
    }
  | {
      readonly type: "state";
      readonly state: "disconnected";
      readonly error: NativeTerminalTransportError | null;
    };

export interface NativeTerminalTransportError {
  readonly code: string;
  readonly reason: string;
  readonly retryable: boolean;
}

export interface NativeTerminalAttachment {
  write(bytes: Uint8Array): Promise<NativeTerminalMutationResult>;
  /** Resolves `ok` only after daemon-authoritative geometry matches this viewport. */
  resize(viewport: TerminalAttachmentViewport): Promise<NativeTerminalMutationResult>;
  dispose(): void;
}

export type NativeTerminalMutationResult =
  | { readonly status: "ok" }
  | { readonly status: "error"; readonly error: NativeTerminalTransportError };

export type NativeTerminalConnectResult =
  | { readonly status: "connected"; readonly attachment: NativeTerminalAttachment }
  | { readonly status: "error"; readonly error: NativeTerminalTransportError };

/**
 * Renderer-owned adapter target for the versioned desktop host capability.
 * It is deliberately semantic: private tmux ids, daemon locations, lease
 * tickets and connection ids cannot be represented here.
 */
export interface NativeTerminalTransport {
  connect(
    request: TerminalAttachRequest,
    listener: (event: NativeTerminalEvent) => void | Promise<void>,
  ): Promise<NativeTerminalConnectResult>;
}

export function validateNativeTerminalRequest(
  request: TerminalAttachRequest,
): TerminalAttachRequest {
  return TerminalAttachRequestSchemaZ.parse(request);
}

export function validateNativeTerminalViewport(
  viewport: TerminalAttachmentViewport,
): TerminalAttachmentViewport {
  return TerminalAttachmentViewportSchemaZ.parse(viewport);
}

export function isNativeTerminalOutput(
  event: NativeTerminalEvent,
): event is Extract<NativeTerminalEvent, { readonly type: "output" }> {
  return event.type === "output" && event.bytes instanceof Uint8Array;
}

export {
  NATIVE_TERMINAL_DEFAULT_ISSUE_TIMEOUT_MS,
  NATIVE_TERMINAL_INPUT_ACK_TIMEOUT_MS,
  NATIVE_TERMINAL_MAX_CONTROL_BYTES,
  NATIVE_TERMINAL_MAX_CONTROL_FRAMES,
  NATIVE_TERMINAL_MAX_CONNECTION_LIFETIME_MS,
  NATIVE_TERMINAL_MAX_DESCRIPTOR_LIFETIME_MS,
  NATIVE_TERMINAL_MAX_INBOUND_CONTROL_FRAMES_PER_WINDOW,
  NATIVE_TERMINAL_MAX_INBOUND_FRAMES_PER_WINDOW,
  NATIVE_TERMINAL_MAX_OUTPUT_FRAME_BYTES,
  NATIVE_TERMINAL_MAX_QUEUED_EVENT_BYTES,
  NATIVE_TERMINAL_MAX_QUEUED_EVENTS,
  NATIVE_TERMINAL_MAX_SOCKET_BUFFERED_BYTES,
  NATIVE_TERMINAL_RATE_WINDOW_MS,
  NATIVE_TERMINAL_RESIZE_ACK_TIMEOUT_MS,
  NATIVE_TERMINAL_WEBSOCKET_PROTOCOL,
  createNativeTerminalWebSocketTransport,
  type NativeTerminalIssueAttachment,
  type NativeTerminalSocketEvent,
  type NativeTerminalSocketListener,
  type NativeTerminalWebSocket,
  type NativeTerminalWebSocketFactory,
  type NativeTerminalWebSocketTransportDependencies,
} from "./native-terminal-websocket-transport.ts";
