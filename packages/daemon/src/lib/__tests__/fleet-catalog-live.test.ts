import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";

import { FleetCatalogResourceV1SchemaZ } from "@tmux-ide/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { startEmbeddedDaemon, type EmbeddedDaemonHandle } from "../daemon-embed.ts";
import { fleetSessionIdForName } from "../../command-center/resources/fleet-catalog.ts";

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

/**
 * End-to-end (m40/fleet-live steps a–c): a SECOND adopted session that the app
 * never opened is visible in the read-only fleet catalog with LIVE ground-truth
 * agent status derived only from its `@agent_state` stamp — no scrape, no
 * attachment — and flipping that stamp is reflected on the next read. Driven
 * against a real embedded daemon over real HTTP on an isolated tmux socket.
 */
describe.skipIf(!hasTmux).sequential("fleet catalog live integration", () => {
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

  const root = mkdtempSync(join("/tmp", "tmux-ide-fleet-live-"));
  const projectDir = join(root, "project");
  const socketPath = join(root, "tmux.sock");
  const keeperSession = "fleet-live-keeper";
  const adoptedSession = `fleet-live-${randomUUID().slice(0, 8)}`;
  const ownerToken = `owner-${randomUUID()}`;
  const executablePath = realpathSync(execFileSync("which", ["tmux"], { encoding: "utf8" }).trim());
  const previousEnvironment: Record<string, string | undefined> = {};
  let handle: EmbeddedDaemonHandle | null = null;

  const run = (argv: readonly string[]): string =>
    execFileSync(executablePath, ["-S", socketPath, ...argv], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 256 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).replace(/(?:\r?\n)+$/u, "");

  beforeAll(() => {
    mkdirSync(projectDir);
    for (const name of [
      "TMUX",
      "TMUX_IDE_DAEMON_INFO_DIR",
      "TMUX_IDE_REGISTRY_DIR",
      "TMUX_IDE_SETTINGS_DIR",
      "TMUX_IDE_HOME",
      "TMUX_IDE_SESSION",
    ]) {
      previousEnvironment[name] = process.env[name];
    }
    process.env.TMUX_IDE_DAEMON_INFO_DIR = join(root, "daemon");
    process.env.TMUX_IDE_REGISTRY_DIR = join(root, "registry");
    process.env.TMUX_IDE_SETTINGS_DIR = join(root, "settings");
    process.env.TMUX_IDE_HOME = join(root, "home");
    delete process.env.TMUX_IDE_SESSION;

    run(["-f", "/dev/null", "new-session", "-d", "-s", keeperSession, "exec sleep 300"]);
    process.env.TMUX = `${socketPath},${process.pid},0`;
  });

  afterAll(async () => {
    await handle?.stop({ gracefulMs: 100 }).catch(() => undefined);
    handle = null;
    spawnSync(executablePath, ["-S", socketPath, "kill-server"], { stdio: "ignore" });
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("shows an unopened adopted session's live agent status and reflects a stamp flip", async () => {
    handle = await startEmbeddedDaemon({
      authToken: "remote-token-is-not-owner",
      localBypassToken: ownerToken,
      silent: true,
    });

    // A real adopted session the app never opened: one single-pane self-reporting
    // agent stamped working, plus a plain shell window.
    const agentPaneId = run([
      "new-session",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-s",
      adoptedSession,
      "-c",
      projectDir,
      "-n",
      "agent",
      "exec sleep 300",
    ]);
    run([
      "set-option",
      "-p",
      "-t",
      agentPaneId,
      "@agent_state",
      `working:${Math.floor(Date.now() / 1000)}`,
    ]);
    run(["set-option", "-p", "-t", agentPaneId, "@agent_display_name", "Live Agent"]);
    run([
      "new-window",
      "-d",
      "-t",
      `${adoptedSession}:`,
      "-c",
      projectDir,
      "-n",
      "shell",
      "exec sleep 300",
    ]);
    run(["set-option", "-t", adoptedSession, "@tmux_ide_adopted", "1"]);

    const sessionId = fleetSessionIdForName(adoptedSession);
    const readCatalog = async () => {
      const response = await fetch(`${handle!.apiBaseUrl}/api/resources/fleet-catalog`, {
        headers: { Authorization: `Bearer ${ownerToken}`, Connection: "close" },
      });
      expect(response.status).toBe(200);
      return FleetCatalogResourceV1SchemaZ.parse(await response.json());
    };

    // (b) The unopened session is present under its opaque id with LIVE authority
    // status — no scrape, no attachment.
    const catalog = await readCatalog();
    const entry = catalog.sessions.find((session) => session.sessionId === sessionId);
    expect(entry).toBeDefined();
    expect(entry!.appCreated).toBe(false);
    expect(entry!.agents).toHaveLength(1);
    expect(entry!.agents[0]).toMatchObject({
      name: "Live Agent",
      activity: "running",
      attention: false,
      statusSource: "authority",
    });

    // Wire audit: the catalog carries the sanitized session name as its display
    // label (the one allowed identity) but never a filesystem path or a raw tmux
    // runtime id.
    const wire = JSON.stringify(catalog);
    expect(wire).not.toContain(projectDir);
    expect(wire).not.toContain(realpathSync(projectDir));
    expect(wire).not.toMatch(/[$%@][0-9]+/u);

    // (c) Flip the ground-truth stamp; the very next read reflects it without a
    // reopen (blocked -> waiting + attention).
    run([
      "set-option",
      "-p",
      "-t",
      agentPaneId,
      "@agent_state",
      `blocked:${Math.floor(Date.now() / 1000)}`,
    ]);
    const flipped = await readCatalog();
    const flippedEntry = flipped.sessions.find((session) => session.sessionId === sessionId);
    expect(flippedEntry!.agents[0]).toMatchObject({
      name: "Live Agent",
      activity: "waiting",
      attention: true,
      statusSource: "authority",
    });
  }, 45_000);
});
