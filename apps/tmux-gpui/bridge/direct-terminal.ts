import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createTmuxServerClient } from "../../../packages/daemon-client/src/tmux-server-client.ts";
import {
  PANE_STREAM_INPUT_LIFETIME_CAPABILITY_VERSION,
  PANE_STREAM_INPUT_BYTES_CAPABILITY_VERSION,
} from "../../../packages/contracts/src/pane-stream.ts";
import {
  TERMINAL_GRAPHICS_CAPABILITY_VERSION,
  TERMINAL_GRAPHICS_ZLIB_CAPABILITY_VERSION,
  TERMINAL_GRAPHICS_CELL_PIXELS_CAPABILITY_VERSION,
  TERMINAL_GRAPHICS_PRECISE_PIXELS_CAPABILITY_VERSION,
} from "../../../packages/contracts/src/terminal-graphics.ts";
import {
  TERMINAL_PROJECTION_CAPABILITY_VERSION,
  TERMINAL_PROJECTION_LOCAL_CAPABILITY_VERSION,
} from "../../../packages/contracts/src/terminal-projection.ts";
import { connectionSchema, paneStreamSocketUrl } from "./config.ts";
import { localPreviewImageAccess, type LocalPreviewHostProof } from "./discovery.ts";

/** Broker only: never redeems the stream, receives terminal cells, or owns a replica. */
export async function issueDirectTerminal(
  input: z.infer<typeof connectionSchema>,
  mode: "read-only" | "interactive",
  signal: AbortSignal,
  requestFetch: typeof fetch = fetch,
  localProof: LocalPreviewHostProof | null = null,
) {
  const config = connectionSchema.parse(input);
  signal.throwIfAborted();
  let localImages = localPreviewImageAccess(localProof, config);
  if (localImages && localProof) {
    await localProof.verify(signal);
    signal.throwIfAborted();
    localImages = localPreviewImageAccess(localProof, config);
  }
  const panes = config.visiblePaneIds ?? [config.semanticPaneId];
  if (!panes.includes(config.semanticPaneId) || new Set(panes).size !== panes.length)
    throw new Error("Invalid native terminal pane set");
  const origin = "tmux-ide://app";
  const hostClientId = `gpui:${randomUUID()}`;
  const client = createTmuxServerClient(
    {
      baseUrl: config.baseUrl,
      ownerToken: config.ownerToken,
      origin,
      hostClientId,
      fetch: (url, init) =>
        requestFetch(url, {
          ...init,
          signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
        }),
    },
    config.scope,
  );
  try {
    const result = await client.issuePaneStream(
      randomUUID(),
      {
        protocolVersion: 2,
        workspaceName: config.workspaceName,
        panes,
        viewerMode: mode,
        terminalDelivery: {
          protocolVersions: [
            1,
            TERMINAL_GRAPHICS_CAPABILITY_VERSION,
            localImages
              ? TERMINAL_PROJECTION_LOCAL_CAPABILITY_VERSION
              : TERMINAL_PROJECTION_CAPABILITY_VERSION,
            TERMINAL_GRAPHICS_ZLIB_CAPABILITY_VERSION,
            TERMINAL_GRAPHICS_CELL_PIXELS_CAPABILITY_VERSION,
            TERMINAL_GRAPHICS_PRECISE_PIXELS_CAPABILITY_VERSION,
            ...(mode === "interactive"
              ? [
                  PANE_STREAM_INPUT_LIFETIME_CAPABILITY_VERSION,
                  PANE_STREAM_INPUT_BYTES_CAPABILITY_VERSION,
                ]
              : []),
          ],
          // Keep the offer valid on older daemons. 111/112 opt into binary projection;
          // older peers ignore them and select compact semantic delivery.
          encodings: ["semantic-compact-v1"],
          richPlacements: true,
        },
      },
      config.liveSessionId,
    );
    signal.throwIfAborted();
    if (localImages && localProof) localPreviewImageAccess(localProof, config);
    if (result.status !== "issued" || result.descriptor.effectiveViewerMode !== mode)
      throw new Error("Native terminal capability refused");
    return {
      // Deliberately enumerate the handoff; the owner credential remains in the broker.
      descriptor: {
        ...result.descriptor,
        webSocketUrl: paneStreamSocketUrl(config, result.descriptor.webSocketUrl),
      },
      // Describes this exact offer, not a daemon acceptance or input authority.
      graphics: true,
      binaryCells: true,
      alternateScreenProjection: true,
      ...(localImages ? { localImages } : {}),
      serverScope: { ...config.scope },
      origin,
      hostClientId,
      workspaceName: config.workspaceName,
      selectedPane: config.semanticPaneId,
    };
  } finally {
    client.dispose();
  }
}
