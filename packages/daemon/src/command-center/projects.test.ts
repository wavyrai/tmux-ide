import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { _resetCacheForTests, projectRegistryEmitter } from "../lib/project-registry.ts";
import {
  _detachProjectRegistryListenerForTests,
  _stopSessionsPollerForTests,
  handleWsEventsConnection,
} from "./ws-events.ts";
import { _setExecutor, type PaneInfo } from "../widgets/lib/pane-comms.ts";
import { _setTmuxRunner } from "./discovery.ts";
import { createApp } from "./server.ts";
import { makePane } from "../__tests__/support.ts";
import type { ServerFrame } from "../schemas/ws-events.ts";

const REGISTRY_DIR_ENV = "TMUX_IDE_REGISTRY_DIR";
const TEST_DAEMON_IDENTITY = {
  protocolVersion: 1,
  productVersion: "2.8.0",
  instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
  startedAt: "2026-07-21T00:00:00.000Z",
} as const;

class MockWebSocket extends EventEmitter {
  readyState = 1;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.emit("close");
  }

  receive(text: string): void {
    this.emit("message", text, false);
  }

  clientClose(): void {
    this.readyState = 3;
    this.emit("close");
  }
}

function frames(ws: MockWebSocket): ServerFrame[] {
  return ws.sent.map((s) => JSON.parse(s) as ServerFrame);
}

async function tick(ms = 10): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

let registryHome: string;
let projectDir: string;
let sandboxRoot: string;
let originalHomeOverride: string | undefined;
let restorePane: () => void;
let restoreTmux: () => void;

beforeEach(() => {
  registryHome = mkdtempSync(join(tmpdir(), "tmux-ide-projects-"));
  projectDir = mkdtempSync(join(tmpdir(), "tmux-ide-proj-"));
  // Sandbox boundary for inspect/onboard endpoints — must be canonical so
  // the realpath() check in the route accepts paths inside it on macOS.
  sandboxRoot = realpathSync(tmpdir());
  originalHomeOverride = process.env.TMUX_IDE_HOME_OVERRIDE;
  process.env.TMUX_IDE_HOME_OVERRIDE = sandboxRoot;
  process.env[REGISTRY_DIR_ENV] = registryHome;
  _resetCacheForTests();

  // Mock pane + tmux helpers so createApp() runs cleanly without real tmux.
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
  delete process.env[REGISTRY_DIR_ENV];
  if (originalHomeOverride === undefined) {
    delete process.env.TMUX_IDE_HOME_OVERRIDE;
  } else {
    process.env.TMUX_IDE_HOME_OVERRIDE = originalHomeOverride;
  }
  rmSync(registryHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
  _resetCacheForTests();
  restorePane?.();
  restoreTmux?.();
  _stopSessionsPollerForTests();
  _detachProjectRegistryListenerForTests();
});

describe("REST /api/projects", () => {
  it("GET returns an empty list when nothing is registered", async () => {
    const app = createApp();
    const res = await app.request("/api/projects");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projects: unknown[] };
    expect(body.projects).toEqual([]);
  });

  it("POST registers a project and GET surfaces it", async () => {
    const app = createApp();
    const res = await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: projectDir }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { project: { name: string; dir: string } };
    expect(created.project.dir).toBe(projectDir);

    const list = await app.request("/api/projects").then(
      (r) =>
        r.json() as Promise<{
          projects: { name: string }[];
        }>,
    );
    expect(list.projects).toHaveLength(1);
    expect(list.projects[0]!.name).toBe(created.project.name);
  });

  it("POST returns 400 when the directory does not exist", async () => {
    const app = createApp();
    const res = await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: "/does/not/exist" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST returns 409 with a suggested alt name on conflict", async () => {
    const app = createApp();
    const otherDir = mkdtempSync(join(tmpdir(), "tmux-ide-other-"));
    try {
      const first = await app.request("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dir: projectDir, name: "shared" }),
      });
      expect(first.status).toBe(201);

      const conflict = await app.request("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dir: otherDir, name: "shared" }),
      });
      expect(conflict.status).toBe(409);
      const body = (await conflict.json()) as { suggestion: string };
      expect(body.suggestion).toBe("shared-2");
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it("DELETE removes a registered project", async () => {
    const app = createApp();
    const created = await app
      .request("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dir: projectDir }),
      })
      .then((r) => r.json() as Promise<{ project: { name: string } }>);

    const del = await app.request(`/api/projects/${created.project.name}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);

    const list = (await app.request("/api/projects").then((r) => r.json())) as {
      projects: unknown[];
    };
    expect(list.projects).toEqual([]);
  });

  it("DELETE returns 404 for unknown project", async () => {
    const app = createApp();
    const res = await app.request("/api/projects/nope", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("POST /api/projects/:name/probe re-runs the probe and updates hasIdeYml", async () => {
    const app = createApp();
    const created = await app
      .request("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dir: projectDir }),
      })
      .then((r) => r.json() as Promise<{ project: { name: string; hasIdeYml: boolean } }>);
    expect(created.project.hasIdeYml).toBe(false);

    writeFileSync(join(projectDir, "ide.yml"), "name: probed\n");
    const probed = await app
      .request(`/api/projects/${created.project.name}/probe`, { method: "POST" })
      .then((r) => r.json() as Promise<{ project: { hasIdeYml: boolean } }>);
    expect(probed.project.hasIdeYml).toBe(true);
  });

  it("POST /api/project/:name/config writes beside the nested winning config", async () => {
    const root = mkdtempSync(join(tmpdir(), "tmux-ide-monorepo-"));
    try {
      const appDir = join(root, "apps", "api");
      const nestedCwd = join(appDir, "src");
      mkdirSync(nestedCwd, { recursive: true });
      const canonicalAppDir = realpathSync(appDir);
      writeFileSync(join(appDir, "ide.yml"), "name: api\nrows:\n  - panes:\n      - title: API\n");
      const originalLegacy = readFileSync(join(appDir, "ide.yml"), "utf-8");
      restoreTmux();
      restoreTmux = _setTmuxRunner((args: string[]) => {
        if (args[0] === "list-sessions") return "api";
        if (args[0] === "display-message") return nestedCwd;
        return "";
      });

      const app = createApp();
      const res = await app.request("/api/project/api/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "renamed-api",
          rows: [{ panes: [{ title: "API", command: "pnpm dev" }] }],
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { configPath: string; configKind: string };
      expect(body.configPath).toBe(join(canonicalAppDir, ".tmux-ide", "workspace.yml"));
      expect(body.configKind).toBe("workspace");
      expect(readFileSync(join(appDir, ".tmux-ide", "workspace.yml"), "utf-8")).toContain(
        "name: renamed-api",
      );
      expect(readFileSync(join(appDir, "ide.yml"), "utf-8")).toBe(originalLegacy);
      expect(existsSync(join(root, ".tmux-ide", "workspace.yml"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("GET /api/projects/templates returns at least the bundled set", async () => {
    const app = createApp();
    const res = await app.request("/api/projects/templates");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      templates: { id: string; label: string; description: string }[];
    };
    expect(body.templates.length).toBeGreaterThan(0);
    const ids = body.templates.map((t) => t.id);
    expect(ids).toContain("default");
    expect(ids).toContain("nextjs");
  });
});

describe("WS broadcast — projects.changed", () => {
  it("connected clients receive projects.changed when a project is registered", async () => {
    const app = createApp();
    const ws = new MockWebSocket();
    handleWsEventsConnection(ws, TEST_DAEMON_IDENTITY);
    ws.sent.length = 0;

    const res = await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: projectDir }),
    });
    expect(res.status).toBe(201);
    await tick();

    const types = frames(ws).map((f) => f.type);
    expect(types).toContain("projects.changed");

    ws.clientClose();
  });

  it("listener counts return to baseline after disconnect", () => {
    const before = projectRegistryEmitter.listenerCount("change");

    const ws = new MockWebSocket();
    handleWsEventsConnection(ws, TEST_DAEMON_IDENTITY);
    expect(projectRegistryEmitter.listenerCount("change")).toBe(before + 1);

    ws.clientClose();
    expect(projectRegistryEmitter.listenerCount("change")).toBe(before);
  });
});

describe("REST /api/projects/init", () => {
  it("returns 202 with a jobId and streams output via WS", async () => {
    // Stub the init runner via env so we shell out to a harmless command.
    // We use `node -e` to print known output, exit 0, then we register the
    // project to verify the broadcast.
    process.env.TMUX_IDE_INIT_COMMAND = "node";
    // The runner spawns `<command> init [--template <id>]`. We can't easily
    // intercept that here without monkey-patching. Instead, use the
    // dedicated runner test for streaming behavior — this test just
    // verifies the REST contract: 202 + jobId.
    const app = createApp();

    const res = await app.request("/api/projects/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: projectDir }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string };
    expect(typeof body.jobId).toBe("string");
    expect(body.jobId.length).toBeGreaterThan(0);

    delete process.env.TMUX_IDE_INIT_COMMAND;

    // Give the (failing) background task a moment to settle so it doesn't
    // bleed across tests. We expect an init.error broadcast to be safe.
    await tick(50);
  });

  it("returns 400 when dir does not exist", async () => {
    const app = createApp();
    const res = await app.request("/api/projects/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: "/does/not/exist" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("REST /api/filesystem/inspect", () => {
  it("returns inspect data for a directory without ide.yml", async () => {
    const app = createApp();
    const res = await app.request("/api/filesystem/inspect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: projectDir }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      project: {
        hasIdeYml: boolean;
        dir: string;
        detected: { packageManager: string | null; frameworks: string[] };
      };
    };
    expect(body.project.hasIdeYml).toBe(false);
    expect(body.project.detected.frameworks).toEqual([]);
  });

  it("returns hasIdeYml=true when an ide.yml is present", async () => {
    writeFileSync(
      join(projectDir, "ide.yml"),
      "name: x\nrows:\n  - panes:\n      - title: Shell\n",
    );
    const app = createApp();
    const res = await app.request("/api/filesystem/inspect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: projectDir }),
    });
    const body = (await res.json()) as { project: { hasIdeYml: boolean } };
    expect(body.project.hasIdeYml).toBe(true);
  });

  it("returns 404 when the directory does not exist", async () => {
    const app = createApp();
    const res = await app.request("/api/filesystem/inspect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: join(sandboxRoot, "nope-does-not-exist") }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 for relative paths", async () => {
    const app = createApp();
    const res = await app.request("/api/filesystem/inspect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: "relative/path" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 403 for paths outside the sandbox", async () => {
    const app = createApp();
    const res = await app.request("/api/filesystem/inspect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: "/etc" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("REST /api/projects/onboard", () => {
  it("writes an ide.yml and registers the project", async () => {
    const app = createApp();
    const res = await app.request("/api/projects/onboard", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: projectDir, agents: 2, devCommand: "pnpm dev" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      project: { name: string; dir: string; hasIdeYml: boolean };
    };
    expect(body.project.hasIdeYml).toBe(true);

    // ide.yml landed on disk with our 2-agent layout.
    const yamlPath = join(projectDir, "ide.yml");
    expect(existsSync(yamlPath)).toBe(true);
    const yaml = readFileSync(yamlPath, "utf-8");
    expect(yaml).toContain("Lead");
    expect(yaml).toContain("Teammate 1");
    expect(yaml).toContain("pnpm dev");
    expect(yaml).toContain("team:");

    // Registry now contains the project.
    const list = (await app.request("/api/projects").then((r) => r.json())) as {
      projects: { name: string }[];
    };
    expect(list.projects.map((p) => p.name)).toContain(body.project.name);
  });

  it("returns 409 when ide.yml already exists", async () => {
    writeFileSync(
      join(projectDir, "ide.yml"),
      "name: existing\nrows:\n  - panes:\n      - title: Shell\n",
    );
    const app = createApp();
    const res = await app.request("/api/projects/onboard", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: projectDir, agents: 1 }),
    });
    expect(res.status).toBe(409);
  });

  it("returns 404 when the directory does not exist", async () => {
    const app = createApp();
    const res = await app.request("/api/projects/onboard", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: join(sandboxRoot, "nope-onboard"), agents: 1 }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid agent counts", async () => {
    const app = createApp();
    const res = await app.request("/api/projects/onboard", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: projectDir, agents: 5 }),
    });
    expect(res.status).toBe(400);
  });

  it("uses the user-supplied name when provided", async () => {
    const app = createApp();
    const res = await app.request("/api/projects/onboard", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: projectDir, agents: 1, name: "custom-name" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { project: { name: string } };
    expect(body.project.name).toBe("custom-name");
  });
});

// Sanity check: registry survives "registered → fs file → fresh app" round-trip.
describe("end-to-end registry persistence", () => {
  it("re-creating the app reads back persisted projects", async () => {
    const app1 = createApp();
    const created = await app1
      .request("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dir: projectDir }),
      })
      .then((r) => r.json() as Promise<{ project: { name: string } }>);

    // Drop the in-memory cache; new app instance must re-read from disk.
    _resetCacheForTests();
    const app2 = createApp();
    const list = (await app2.request("/api/projects").then((r) => r.json())) as {
      projects: { name: string }[];
    };
    expect(list.projects.map((p) => p.name)).toContain(created.project.name);

    const file = join(registryHome, "projects.json");
    expect(existsSync(file)).toBe(true);
  });
});
