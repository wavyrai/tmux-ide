import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TmuxServerSessionsResourceSchemaZ,
  TmuxServerSessionsResourceV2SchemaZ,
} from "@tmux-ide/contracts";
import { TmuxServerOwners } from "../lib/tmux-server-owners.ts";
import type { NativeTmuxServerOwner } from "../lib/tmux-server-owner.ts";
import { mountTmuxServerRoutes } from "./tmux-servers.ts";

const token = "private-owner-token";
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tmux-ide-favicon-route-"));
  directories.push(dir);
  return dir;
}
interface Row {
  readonly liveSessionId: string;
  readonly sessionName: string;
  readonly paneCount: number;
  readonly windowCount: number;
  readonly lastActivity: number | null;
  readonly sessionPath: string;
}
async function fixture(rows: readonly Row[]) {
  const catalog = vi.fn(async () => rows.map((row) => ({ ...row })));
  const manager = new TmuxServerOwners<NativeTmuxServerOwner>({
    probe: async (selector) => ({
      fingerprint: JSON.stringify(selector),
      authority: { executablePath: "/private/tmux", socketSelector: selector },
      valid: () => true,
    }),
    create: async () =>
      ({
        catalog,
        dispose: async () => {},
        workspaceRegistry: {
          list: () => [{ name: "workspace.alias", sessionName: "web" }],
          get: () => null,
        },
      }) as unknown as NativeTmuxServerOwner,
  });
  const app = new Hono();
  mountTmuxServerRoutes(app, { owners: manager, ownerToken: token });
  const server = await manager.register({ label: "A", selector: { kind: "name", name: "a" } });
  const get = async (query: string) => {
    const response = await app.request(
      `/api/v1/tmux-servers/${server.serverId}/${server.generation}/sessions${query}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, unknown> & {
      sessions: Record<string, unknown>[];
    };
  };
  return { get, server, catalog };
}
const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>';
const id = (letter: string) => `live-session.${letter.repeat(20)}`;

describe("GET tmux-servers/:server/:generation/sessions?version=2", () => {
  it("adds window count, last activity and the project favicon found from session_path", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "public"));
    writeFileSync(join(dir, "public", "favicon.svg"), svg);
    const plain = tempDir();
    const f = await fixture([
      {
        liveSessionId: id("a"),
        sessionName: "web",
        paneCount: 3,
        windowCount: 2,
        lastActivity: 1793635178,
        sessionPath: dir,
      },
      {
        liveSessionId: id("b"),
        sessionName: "plain",
        paneCount: 1,
        windowCount: 1,
        lastActivity: null,
        sessionPath: plain,
      },
      {
        liveSessionId: id("c"),
        sessionName: "relative",
        paneCount: 1,
        windowCount: 1,
        lastActivity: 5,
        sessionPath: "relative/path",
      },
    ]);
    const body = await f.get("?version=2");
    expect(body).toEqual({
      version: 2,
      server: { serverId: f.server.serverId, generation: f.server.generation },
      sessions: [
        {
          liveSessionId: id("a"),
          sessionName: "web",
          workspaceName: "workspace.alias",
          paneCount: 3,
          windowCount: 2,
          lastActivity: 1793635178,
          favicon: { mime: "image/svg+xml", data: Buffer.from(svg).toString("base64") },
        },
        {
          liveSessionId: id("b"),
          sessionName: "plain",
          workspaceName: null,
          paneCount: 1,
          windowCount: 1,
          lastActivity: null,
          favicon: null,
        },
        {
          liveSessionId: id("c"),
          sessionName: "relative",
          workspaceName: null,
          paneCount: 1,
          windowCount: 1,
          lastActivity: 5,
          favicon: null,
        },
      ],
    });
    expect(TmuxServerSessionsResourceV2SchemaZ.parse(body)).toEqual(body);
  });

  it("keeps the version 1 resource byte-for-byte for old clients", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "favicon.svg"), svg);
    const f = await fixture([
      {
        liveSessionId: id("a"),
        sessionName: "web",
        paneCount: 3,
        windowCount: 2,
        lastActivity: 9,
        sessionPath: dir,
      },
    ]);
    const expected = {
      version: 1,
      server: { serverId: f.server.serverId, generation: f.server.generation },
      sessions: [
        {
          liveSessionId: id("a"),
          sessionName: "web",
          workspaceName: "workspace.alias",
          paneCount: 3,
        },
      ],
    };
    for (const query of ["", "?version=1", "?version=3", "?version=2x"]) {
      const body = await f.get(query);
      expect(JSON.stringify(body)).toBe(JSON.stringify(expected));
      expect(TmuxServerSessionsResourceSchemaZ.parse(body)).toEqual(body);
    }
  });

  it("fills the favicon budget exactly to 512 KiB and no further", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "favicon.png"), Buffer.alloc(32_768, 1));
    const small = tempDir();
    writeFileSync(join(small, "favicon.svg"), svg);
    const row = (index: number, sessionPath: string) => ({
      liveSessionId: `live-session.${String(index).padStart(20, "0")}`,
      sessionName: `s${index}`,
      paneCount: 1,
      windowCount: 1,
      lastActivity: 1,
      sessionPath,
    });
    const f = await fixture([
      ...Array.from({ length: 17 }, (_, index) => row(index, dir)),
      row(17, small),
    ]);
    const favicons = (await f.get("?version=2")).sessions.map((session) => session.favicon);
    // 16 × 32 768 = 524 288 exactly fills the budget; nothing more fits, not even a tiny icon.
    expect(favicons.slice(0, 16).every((favicon) => favicon !== null)).toBe(true);
    expect(favicons.slice(16)).toEqual([null, null]);
  });

  it("drops favicons beyond the response's total favicon budget instead of failing", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "favicon.png"), Buffer.alloc(30_000, 7));
    const small = tempDir();
    writeFileSync(join(small, "favicon.svg"), svg);
    const rows = Array.from({ length: 21 }, (_, index) => ({
      liveSessionId: `live-session.${String(index).padStart(20, "0")}`,
      sessionName: `s${index}`,
      paneCount: 1,
      windowCount: 1,
      lastActivity: 1,
      sessionPath: index === 20 ? small : dir,
    }));
    const f = await fixture(rows);
    const body = await f.get("?version=2");
    const favicons = body.sessions.map((session) => session.favicon);
    // 17 × 30 000 = 510 000 ≤ 512 KiB; an 18th would be 540 000. A small icon after them still fits.
    expect(favicons.slice(0, 17).every((favicon) => favicon !== null)).toBe(true);
    expect(favicons.slice(17, 20)).toEqual([null, null, null]);
    expect(favicons[20]).toEqual({
      mime: "image/svg+xml",
      data: Buffer.from(svg).toString("base64"),
    });
    expect(favicons[0]).toEqual({
      mime: "image/png",
      data: Buffer.alloc(30_000, 7).toString("base64"),
    });
  });

  it("never follows a symlinked favicon or directory out of the project", async () => {
    const outside = tempDir();
    writeFileSync(join(outside, "favicon.svg"), svg);
    const dir = tempDir();
    symlinkSync(join(outside, "favicon.svg"), join(dir, "favicon.svg"));
    symlinkSync(outside, join(dir, "public"));
    const f = await fixture([
      {
        liveSessionId: id("a"),
        sessionName: "web",
        paneCount: 1,
        windowCount: 1,
        lastActivity: 1,
        sessionPath: dir,
      },
    ]);
    expect((await f.get("?version=2")).sessions[0]!.favicon).toBeNull();
  });
});
