import { describe, expect, it } from "vitest";
import {
  TMUX_SERVER_SESSION_FAVICON_MAX_BYTES,
  TmuxServerSessionsResourceSchemaZ,
  TmuxServerSessionsResourceV2SchemaZ,
} from "./tmux-server-scope.ts";

const server = {
  serverId: `tmux-server.${"0".repeat(32)}`,
  generation: "0b5e3d3e-1c55-4d56-9b0e-2a3c4d5e6f70",
};
const v1Session = {
  liveSessionId: `live-session.${"a".repeat(20)}`,
  sessionName: "web",
  workspaceName: null,
  paneCount: 2,
};
const v2Session = {
  ...v1Session,
  windowCount: 1,
  lastActivity: 1793635178,
  favicon: { mime: "image/png", data: Buffer.from("png").toString("base64") },
};
const v2 = (session: Record<string, unknown>) => ({ version: 2, server, sessions: [session] });

describe("tmux server sessions resource", () => {
  it("keeps version 1 strict: no new fields and no version 2", () => {
    expect(
      TmuxServerSessionsResourceSchemaZ.safeParse({ version: 1, server, sessions: [v1Session] })
        .success,
    ).toBe(true);
    expect(
      TmuxServerSessionsResourceSchemaZ.safeParse({ version: 1, server, sessions: [v2Session] })
        .success,
    ).toBe(false);
    expect(
      TmuxServerSessionsResourceSchemaZ.safeParse({ version: 2, server, sessions: [v1Session] })
        .success,
    ).toBe(false);
  });

  it("accepts version 2 rows with windows, activity and an optional favicon", () => {
    expect(TmuxServerSessionsResourceV2SchemaZ.parse(v2(v2Session))).toEqual(v2(v2Session));
    for (const mime of [
      "image/png",
      "image/svg+xml",
      "image/x-icon",
      "image/jpeg",
      "image/webp",
      "image/gif",
    ])
      expect(
        TmuxServerSessionsResourceV2SchemaZ.safeParse(
          v2({ ...v2Session, favicon: { mime, data: "" } }),
        ).success,
      ).toBe(true);
    expect(
      TmuxServerSessionsResourceV2SchemaZ.safeParse(
        v2({ ...v2Session, favicon: null, lastActivity: null }),
      ).success,
    ).toBe(true);
    expect(
      TmuxServerSessionsResourceV2SchemaZ.safeParse({ version: 1, server, sessions: [v2Session] })
        .success,
    ).toBe(false);
  });

  it("rejects malformed version 2 rows", () => {
    const bad = [
      { ...v2Session, windowCount: 0 },
      { ...v2Session, windowCount: 1.5 },
      { ...v2Session, lastActivity: -1 },
      { ...v2Session, lastActivity: 1.5 },
      { ...v2Session, favicon: { mime: "image/bmp", data: "" } },
      { ...v2Session, favicon: { mime: "text/html", data: "" } },
      { ...v2Session, favicon: { mime: "image/png", data: "not base64!" } },
      { ...v2Session, favicon: { mime: "image/png", data: "", extra: 1 } },
      { ...v2Session, extra: 1 },
      v1Session,
    ];
    for (const session of bad)
      expect(
        TmuxServerSessionsResourceV2SchemaZ.safeParse(v2(session)).success,
        JSON.stringify(session),
      ).toBe(false);
  });

  it("caps a favicon at 32 KiB of raw bytes", () => {
    expect(TMUX_SERVER_SESSION_FAVICON_MAX_BYTES).toBe(32_768);
    const at = Buffer.alloc(32_768, 1).toString("base64");
    const over = Buffer.alloc(32_769, 1).toString("base64");
    expect(
      TmuxServerSessionsResourceV2SchemaZ.safeParse(
        v2({ ...v2Session, favicon: { mime: "image/png", data: at } }),
      ).success,
    ).toBe(true);
    expect(
      TmuxServerSessionsResourceV2SchemaZ.safeParse(
        v2({ ...v2Session, favicon: { mime: "image/png", data: over } }),
      ).success,
    ).toBe(false);
  });
});
