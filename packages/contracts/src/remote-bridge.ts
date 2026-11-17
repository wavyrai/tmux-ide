import { z } from "zod";

/**
 * The per-machine bridge: one owner-authenticated WebSocket on which the
 * daemon reports facts about its panes to the Mac app. Phase 1 carries
 * clipboard writes from OSC 52.
 *
 * The daemon only reports. No daemon frame asks the app for anything from
 * the Mac (its clipboard, its files, its environment); the frame-kind test
 * in `__tests__/remote-bridge.test.ts` fails if one ever gains such a shape.
 */
export const REMOTE_BRIDGE_PATH = "/api/v2/bridge";
export const REMOTE_BRIDGE_SUBPROTOCOL = "tmux-ide-bridge-v1";
export const REMOTE_BRIDGE_VERSION = 1;
export const REMOTE_BRIDGE_FEATURES = ["clipboard-write"] as const;
/** Largest text a pane may put on the Mac clipboard, in decoded UTF-8 bytes. */
export const REMOTE_CLIPBOARD_MAX_BYTES = 1024 * 1024;
/** Client frames are a small hello; anything larger closes the bridge. */
export const REMOTE_BRIDGE_MAX_CLIENT_FRAME_BYTES = 4096;

/** Advertised in `POST /api/v2/capabilities?remoteBridge=1`; absent on older daemons. */
export const RemoteBridgeCapabilitySchemaZ = z
  .object({
    version: z.literal(REMOTE_BRIDGE_VERSION),
    path: z.literal(REMOTE_BRIDGE_PATH),
    features: z.array(z.enum(REMOTE_BRIDGE_FEATURES)),
  })
  .strict();
export type RemoteBridgeCapability = z.infer<typeof RemoteBridgeCapabilitySchemaZ>;

export const RemoteBridgeHelloSchemaZ = z
  .object({ type: z.literal("hello"), version: z.literal(REMOTE_BRIDGE_VERSION) })
  .strict();
export const RemoteBridgeClientFrameSchemaZ = RemoteBridgeHelloSchemaZ;
export type RemoteBridgeClientFrame = z.infer<typeof RemoteBridgeClientFrameSchemaZ>;

const PaneAddressShape = {
  /** tmux session that owns the pane. */
  session: z.string().min(1),
  /** The semantic pane id the pane stream uses. */
  paneId: z.string().min(1),
  incarnation: z.string().min(1),
};

export const RemoteBridgeReadySchemaZ = z
  .object({
    type: z.literal("ready"),
    version: z.literal(REMOTE_BRIDGE_VERSION),
    features: z.array(z.enum(REMOTE_BRIDGE_FEATURES)),
  })
  .strict();

export const RemoteClipboardWriteSchemaZ = z
  .object({
    type: z.literal("clipboard.write"),
    ...PaneAddressShape,
    bytes: z.number().int().min(1).max(REMOTE_CLIPBOARD_MAX_BYTES),
    text: z.string().min(1),
  })
  .strict();

export const RemoteClipboardRefusedSchemaZ = z
  .object({
    type: z.literal("clipboard.refused"),
    ...PaneAddressShape,
    bytes: z.number().int().min(0),
    reason: z.literal("too-large"),
  })
  .strict();

export const RemoteBridgeServerFrameSchemaZ = z.discriminatedUnion("type", [
  RemoteBridgeReadySchemaZ,
  RemoteClipboardWriteSchemaZ,
  RemoteClipboardRefusedSchemaZ,
]);
export type RemoteBridgeServerFrame = z.infer<typeof RemoteBridgeServerFrameSchemaZ>;
export type RemoteClipboardWrite = z.infer<typeof RemoteClipboardWriteSchemaZ>;
export type RemoteClipboardRefused = z.infer<typeof RemoteClipboardRefusedSchemaZ>;
export type RemoteClipboardEvent = RemoteClipboardWrite | RemoteClipboardRefused;
