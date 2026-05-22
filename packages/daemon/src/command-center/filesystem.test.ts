import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _setExecutor, type PaneInfo } from "../widgets/lib/pane-comms.ts";
import { _setTmuxRunner } from "./discovery.ts";
import { createApp } from "./server.ts";
import { makePane } from "../__tests__/support.ts";

let originalHome: string | undefined;
let sandboxRoot: string;
let restorePane: () => void;
let restoreTmux: () => void;

beforeEach(() => {
  // Pin HOME inside a temp dir so the sandbox accepts our test paths.
  // realpathSync resolves /var/folders → /private/var/folders on macOS so
  // canonical comparisons work later.
  sandboxRoot = realpathSync(mkdtempSync(join(tmpdir(), "fs-route-home-")));
  originalHome = process.env.TMUX_IDE_HOME_OVERRIDE;
  process.env.TMUX_IDE_HOME_OVERRIDE = sandboxRoot;

  // Stub tmux + pane io so createApp() boots without a live tmux server.
  const mockPanes: PaneInfo[] = [makePane({ id: "%1", index: 0, title: "Shell", active: true })];
  restorePane = _setExecutor((_cmd: string, args: string[]) => {
    if (args[0] === "list-panes") {
      return mockPanes
        .map(
          (p) =>
            `${p.id}\t${p.index}\t${p.title}\t${p.currentCommand}\t${p.width}\t${p.height}\t${p.active ? "1" : "0"}\t${p.role ?? ""}\t${p.name ?? ""}\t${p.type ?? ""}`,
        )
        .join("\n");
    }
    return "";
  });
  restoreTmux = _setTmuxRunner((args: string[]) => {
    if (args[0] === "list-sessions") return "";
    return "";
  });
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.TMUX_IDE_HOME_OVERRIDE;
  } else {
    process.env.TMUX_IDE_HOME_OVERRIDE = originalHome;
  }
  rmSync(sandboxRoot, { recursive: true, force: true });
  restorePane?.();
  restoreTmux?.();
});

describe("GET /api/filesystem/browse", () => {
  it("defaults to home when no path is given", async () => {
    mkdirSync(join(sandboxRoot, "alpha"));
    writeFileSync(join(sandboxRoot, "README.md"), "");
    const app = createApp();
    const res = await app.request("/api/filesystem/browse");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      path: string;
      parentPath: string | null;
      entries: { name: string; isDir: boolean }[];
    };
    expect(body.path).toBe(sandboxRoot);
    expect(body.entries.map((e) => e.name)).toEqual(["alpha", "README.md"]);
  });

  it("filters hidden files unless showHidden=true", async () => {
    writeFileSync(join(sandboxRoot, ".env"), "");
    writeFileSync(join(sandboxRoot, "README.md"), "");

    const app = createApp();
    const hidden = (await app.request("/api/filesystem/browse").then((r) => r.json())) as {
      entries: { name: string }[];
    };
    expect(hidden.entries.map((e) => e.name)).not.toContain(".env");

    const visible = (await app
      .request("/api/filesystem/browse?showHidden=true")
      .then((r) => r.json())) as { entries: { name: string }[] };
    expect(visible.entries.map((e) => e.name)).toContain(".env");
  });

  it("returns 403 outside-sandbox for /etc", async () => {
    const app = createApp();
    const res = await app.request("/api/filesystem/browse?path=/etc");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("outside-sandbox");
  });

  it("returns 404 for paths that do not exist", async () => {
    const app = createApp();
    const res = await app.request(
      `/api/filesystem/browse?path=${encodeURIComponent(join(sandboxRoot, "nope"))}`,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not-found");
  });

  it("returns 400 for relative paths", async () => {
    const app = createApp();
    const res = await app.request("/api/filesystem/browse?path=relative");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid-path");
  });

  it("annotates symlinks", async () => {
    mkdirSync(join(sandboxRoot, "real-dir"));
    symlinkSync(join(sandboxRoot, "real-dir"), join(sandboxRoot, "link"));

    const app = createApp();
    const res = await app.request("/api/filesystem/browse");
    const body = (await res.json()) as {
      entries: { name: string; isDir: boolean; isSymlink: boolean }[];
    };
    const link = body.entries.find((e) => e.name === "link");
    expect(link).toBeDefined();
    expect(link?.isDir).toBe(true);
    expect(link?.isSymlink).toBe(true);
  });
});
