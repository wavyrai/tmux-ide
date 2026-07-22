import {
  TerminalAttachRequestSchemaZ,
  TerminalAttachmentViewportSchemaZ,
  type TerminalAttachRequest,
  type TerminalAttachmentViewport,
} from "@tmux-ide/contracts";

export type NativeTerminalConnectionState = "connected" | "disconnected";

export type NativeTerminalEvent =
  | { readonly type: "output"; readonly bytes: Uint8Array }
  | {
      readonly type: "state";
      readonly state: NativeTerminalConnectionState;
      readonly error: NativeTerminalTransportError | null;
    };

export interface NativeTerminalTransportError {
  readonly code: string;
  readonly reason: string;
  readonly retryable: boolean;
}

export interface NativeTerminalAttachment {
  write(bytes: Uint8Array): Promise<NativeTerminalMutationResult>;
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
