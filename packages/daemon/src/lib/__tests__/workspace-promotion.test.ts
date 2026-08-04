import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Workspace, WorkspacePromoteMutationRequest } from "@tmux-ide/contracts";

import {
  WorkspacePromotionAuthority,
  WorkspacePromotionError,
  type WorkspacePromotionIo,
} from "../workspace-promotion.ts";
import { WorkspaceAlreadyExistsError, type AddWorkspaceInput } from "../workspace-registry.ts";
import { fleetSessionIdForName } from "../../command-center/resources/fleet-catalog.ts";
import { TmuxError } from "@tmux-ide/tmux-bridge";

const DAEMON = "20000000-0000-4000-8000-000000000002";
const NOW_SEC = 1_800_000_000;
const NOW_MS = NOW_SEC * 1000;

// ---------------------------------------------------------------------------
// A minimal in-memory tmux server. It renders whatever `-F` format template the
// authority passes by substituting `#{token}` occurrences, so the mock never
// hard-codes the module-private FIELD/SENTINEL layout — the real parser and the
// real format string are exercised end to end.
// ---------------------------------------------------------------------------

interface MockPane {
  id: string;
  active: boolean;
  currentPath: string;
  currentCommand: string;
  options: Map<string, string>;
}
interface MockWindow {
  id: string;
  name: string;
  options: Map<string, string>;
  panes: MockPane[];
}
interface MockSession {
  name: string;
  id: string;
  path: string;
  options: Map<string, string>;
  windows: MockWindow[];
}

class MockTmux {
  readonly sessions: MockSession[] = [];

  session(name: string, id: string, options: Record<string, string> = {}, path = ""): MockSession {
    const session: MockSession = {
      name,
      id,
      path,
      options: new Map(Object.entries(options)),
      windows: [],
    };
    this.sessions.push(session);
    return session;
  }

  window(session: MockSession, id: string, name: string): MockWindow {
    const window: MockWindow = { id, name, options: new Map(), panes: [] };
    session.windows.push(window);
    return window;
  }

  pane(
    window: MockWindow,
    id: string,
    fields: {
      active?: boolean;
      currentPath?: string;
      currentCommand?: string;
      options?: Record<string, string>;
    } = {},
  ): MockPane {
    const pane: MockPane = {
      id,
      active: fields.active ?? false,
      currentPath: fields.currentPath ?? "/tmp/promote-project",
      currentCommand: fields.currentCommand ?? "zsh",
      options: new Map(Object.entries(fields.options ?? {})),
    };
    window.panes.push(pane);
    return pane;
  }

  paneOption(paneId: string): MockPane | null {
    for (const session of this.sessions) {
      for (const window of session.windows) {
        for (const pane of window.panes) if (pane.id === paneId) return pane;
      }
    }
    return null;
  }

  windowOf(windowId: string): { session: MockSession; window: MockWindow } | null {
    for (const session of this.sessions) {
      for (const window of session.windows) {
        if (window.id === windowId) return { session, window };
      }
    }
    return null;
  }

  sessionOf(sessionId: string): MockSession | null {
    return this.sessions.find((session) => session.id === sessionId) ?? null;
  }

  run = (args: readonly string[]): string => {
    const [command] = args;
    if (command === "list-sessions") {
      const format = this.#format(args);
      return this.sessions.map((session) => this.#render(format, { session })).join("\n");
    }
    if (command === "list-panes") {
      const target = this.#target(args);
      const session = this.sessions.find((candidate) => candidate.id === target);
      if (!session) throw new TmuxError("no session", "SESSION_NOT_FOUND");
      const format = this.#format(args);
      const lines: string[] = [];
      for (const window of session.windows) {
        for (const pane of window.panes) {
          lines.push(this.#render(format, { session, window, pane }));
        }
      }
      return lines.join("\n");
    }
    if (command === "set-option") {
      this.#setOption(args);
      return "";
    }
    throw new Error(`unexpected tmux command: ${args.join(" ")}`);
  };

  #target(args: readonly string[]): string {
    const index = args.indexOf("-t");
    return index >= 0 ? args[index + 1]! : "";
  }
  #format(args: readonly string[]): string {
    const index = args.indexOf("-F");
    return index >= 0 ? args[index + 1]! : "";
  }

  #setOption(args: readonly string[]): void {
    const pane = args.includes("-p");
    const window = args.includes("-w");
    const target = this.#target(args);
    const tail = args.slice(args.indexOf("-t") + 2);
    const [option, value] = tail;
    if (option === undefined || value === undefined) throw new Error("bad set-option");
    if (pane) {
      const found = this.paneOption(target);
      if (!found) throw new TmuxError("no pane", "SESSION_NOT_FOUND");
      found.options.set(option, value);
    } else if (window) {
      const found = this.windowOf(target);
      if (!found) throw new TmuxError("no window", "SESSION_NOT_FOUND");
      found.window.options.set(option, value);
    } else {
      const found = this.sessionOf(target);
      if (!found) throw new TmuxError("no session", "SESSION_NOT_FOUND");
      found.options.set(option, value);
    }
  }

  #render(
    format: string,
    ctx: { session: MockSession; window?: MockWindow; pane?: MockPane },
  ): string {
    return format.replace(/#\{([^}]+)\}/gu, (_match, token: string) => this.#token(token, ctx));
  }

  #token(
    token: string,
    ctx: { session: MockSession; window?: MockWindow; pane?: MockPane },
  ): string {
    const { session, window, pane } = ctx;
    switch (token) {
      case "session_name":
        return session.name;
      case "session_id":
        return session.id;
      case "session_path":
        return session.path;
      case "session_windows":
        return String(session.windows.length);
      case "window_id":
        return window?.id ?? "";
      case "window_name":
        return window?.name ?? "";
      case "window_panes":
        return String(window?.panes.length ?? 0);
      case "pane_id":
        return pane?.id ?? "";
      case "pane_active":
        return pane?.active ? "1" : "0";
      case "pane_current_path":
        return pane?.currentPath ?? "";
      case "pane_current_command":
        return pane?.currentCommand ?? "";
      default:
        break;
    }
    // User option (`@...`) with tmux pane -> window -> session inheritance.
    if (pane?.options.has(token)) return pane.options.get(token)!;
    if (window?.options.has(token)) return window.options.get(token)!;
    if (session.options.has(token)) return session.options.get(token)!;
    return "";
  }
}

class FakeRegistry {
  readonly workspaces: Workspace[] = [];
  list(): Workspace[] {
    return [...this.workspaces];
  }
  add(input: AddWorkspaceInput): Workspace {
    if (this.workspaces.some((workspace) => workspace.name === input.name)) {
      throw new WorkspaceAlreadyExistsError(input.name);
    }
    const workspace: Workspace = {
      name: input.name,
      sessionName: input.sessionName ?? input.name,
      projectDir: input.projectDir,
      ideConfigPath: input.ideConfigPath ?? null,
      configKind: input.configKind,
      configPath: input.configPath,
      hasWorkspaceConfig: input.hasWorkspaceConfig,
      addedAt: new Date(NOW_MS).toISOString(),
    };
    this.workspaces.push(workspace);
    return workspace;
  }
}

function io(
  mock: MockTmux,
  overrides: Partial<WorkspacePromotionIo> = {},
): Partial<WorkspacePromotionIo> {
  return {
    runTmux: mock.run,
    canonicalProjectDir: (path) => path,
    now: () => NOW_MS,
    ...overrides,
  };
}

function request(
  sessionId: string,
  overrides: Partial<WorkspacePromoteMutationRequest> = {},
): WorkspacePromoteMutationRequest {
  return {
    operationId: overrides.operationId ?? randomUUID(),
    expectedDaemonInstanceId: overrides.expectedDaemonInstanceId ?? DAEMON,
    intent: overrides.intent ?? { sessionId },
  };
}

/** An adopted, single-window session with one self-reporting agent pane. */
function adoptedAgentSession(
  mock: MockTmux,
  name = "fleet-alpha",
): { name: string; sessionId: string } {
  const session = mock.session(name, "$1", { "@tmux_ide_adopted": "1" });
  const window = mock.window(session, "@1", "claude");
  mock.pane(window, "%1", {
    active: true,
    currentCommand: "claude",
    options: { "@agent_state": `working:${NOW_SEC}`, "@agent_display_name": "Alpha Agent" },
  });
  return { name, sessionId: session.id };
}

describe("WorkspacePromotionAuthority", () => {
  it("promotes an adopted session: stamps panes, classifies the agent, admits to the registry", async () => {
    const mock = new MockTmux();
    const { name } = adoptedAgentSession(mock);
    const registry = new FakeRegistry();
    const authority = new WorkspacePromotionAuthority({
      daemonInstanceId: DAEMON,
      registry,
      io: io(mock),
    });

    const result = await authority.promote(request(fleetSessionIdForName(name)));

    expect(result.outcome).toBe("promoted");
    expect(result.resource.resourceVersion).toBe(1);
    expect(result.resource.workspaceName).toMatch(/^fleet-alpha-[0-9a-f]{32}$/u);
    // Wire-safe: no path or tmux runtime id leaks in the result. The workspace
    // name legitimately embeds the sanitized session basename (as m32 embeds the
    // project basename); only paths and `$`/`%`/`@` runtime ids are forbidden.
    expect(JSON.stringify(result)).not.toMatch(/promote-project|\$[0-9]|%[0-9]|@[0-9]/u);

    const pane = mock.paneOption("%1")!;
    expect(pane.options.get("@tmux_ide_pane_id")).toMatch(/^pane\.promoted\.[0-9a-f]{20}$/u);
    expect(pane.options.get("@ide_type")).toBe("agent");
    expect(pane.options.get("@ide_role")).toBe("agent");
    expect(pane.options.get("@ide_name")).toBe("Alpha Agent");

    const window = mock.windowOf("@1")!.window;
    expect(window.options.get("@tmux_ide_window_id")).toMatch(/^window\.promoted\.[0-9a-f]{20}$/u);

    const session = mock.sessionOf("$1")!;
    expect(session.options.get("@tmux_ide_workspace_name")).toBe(result.resource.workspaceName);
    expect(session.options.get("@tmux_ide_workspace_promoted_v1")).toBe("1");
    // The distinct promotion marker is used — never the m32 open marker.
    expect(session.options.has("@tmux_ide_workspace_open_v1")).toBe(false);

    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]).toMatchObject({
      name: result.resource.workspaceName,
      sessionName: name,
      projectDir: "/tmp/promote-project",
      configKind: "none",
    });
  });

  it("replays an identical operation id without a second registry admission", async () => {
    const mock = new MockTmux();
    const { name } = adoptedAgentSession(mock);
    const registry = new FakeRegistry();
    const authority = new WorkspacePromotionAuthority({
      daemonInstanceId: DAEMON,
      registry,
      io: io(mock),
    });
    const operationId = randomUUID();

    const first = await authority.promote(request(fleetSessionIdForName(name), { operationId }));
    const second = await authority.promote(request(fleetSessionIdForName(name), { operationId }));

    expect(first.outcome).toBe("promoted");
    expect(second.outcome).toBe("replayed");
    expect(second.resource).toEqual(first.resource);
    expect(registry.list()).toHaveLength(1);
  });

  it("re-promotes an already-registered session as replayed under a fresh operation id", async () => {
    const mock = new MockTmux();
    const { name } = adoptedAgentSession(mock);
    const registry = new FakeRegistry();
    const authority = new WorkspacePromotionAuthority({
      daemonInstanceId: DAEMON,
      registry,
      io: io(mock),
    });

    const first = await authority.promote(request(fleetSessionIdForName(name)));
    const second = await authority.promote(request(fleetSessionIdForName(name)));

    expect(first.outcome).toBe("promoted");
    expect(second.outcome).toBe("replayed");
    expect(second.resource.workspaceName).toBe(first.resource.workspaceName);
    expect(registry.list()).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Reconciliation. A registry entry is keyed by session NAME and lives on disk,
  // so it outlives the tmux server; the pane-local stamps do not. A session
  // re-created under a registered name is therefore registered AND unstamped —
  // every pane resolves to `missing-semantic-stamp` and no attachment path
  // works. Promotion is the app's only repair verb for that state.
  // ---------------------------------------------------------------------------
  describe("already-registered session reconciliation", () => {
    /** A registered workspace whose live session carries no pane/window stamps. */
    function registeredButUnstamped(
      mock: MockTmux,
      registry: FakeRegistry,
      name = "fleet-revived",
    ) {
      const session = mock.session(name, "$1", { "@tmux_ide_adopted": "1" });
      const w1 = mock.window(session, "@1", "agent");
      mock.pane(w1, "%0", { active: true, currentCommand: "claude" });
      const w2 = mock.window(session, "@2", "work");
      mock.pane(w2, "%1", { currentCommand: "zsh" });
      mock.pane(w2, "%2", { currentCommand: "vim" });
      const workspace = registry.add({
        name: `${name}-existing`,
        sessionName: name,
        projectDir: "/tmp/promote-project",
        ideConfigPath: null,
        configKind: "none",
        configPath: null,
        hasWorkspaceConfig: false,
      });
      return { name, workspace };
    }

    it("re-stamps the panes and windows of a registered session that lost its stamps", async () => {
      const mock = new MockTmux();
      const registry = new FakeRegistry();
      const { name, workspace } = registeredButUnstamped(mock, registry);
      const authority = new WorkspacePromotionAuthority({
        daemonInstanceId: DAEMON,
        registry,
        io: io(mock),
      });

      const result = await authority.promote(request(fleetSessionIdForName(name)));

      // Idempotent outcome against the EXISTING workspace, no second admission.
      expect(result.outcome).toBe("replayed");
      expect(result.resource.workspaceName).toBe(workspace.name);
      expect(registry.list()).toHaveLength(1);

      // Every pane now carries a durable stamp and `@ide_*` presentation.
      for (const paneId of ["%0", "%1", "%2"]) {
        expect(mock.paneOption(paneId)!.options.get("@tmux_ide_pane_id")).toMatch(
          /^pane\.promoted\.[0-9a-f]{20}$/u,
        );
      }
      expect(mock.paneOption("%0")!.options.get("@ide_type")).toBe("agent");
      expect(mock.paneOption("%1")!.options.get("@ide_name")).toBe("Terminal");
      // Stamps are unique per pane, so the catalog sees no duplicate binding.
      const stamps = ["%0", "%1", "%2"].map(
        (paneId) => mock.paneOption(paneId)!.options.get("@tmux_ide_pane_id")!,
      );
      expect(new Set(stamps).size).toBe(3);

      // Both windows carry a durable, distinct window stamp — the multi-pane
      // window is unattachable without one.
      const windowStamps = ["@1", "@2"].map(
        (windowId) => mock.windowOf(windowId)!.window.options.get("@tmux_ide_window_id")!,
      );
      for (const stamp of windowStamps) expect(stamp).toMatch(/^window\.promoted\.[0-9a-f]{20}$/u);
      expect(new Set(windowStamps).size).toBe(2);
    });

    it("never writes promotion provenance onto an already-registered session", async () => {
      const mock = new MockTmux();
      const registry = new FakeRegistry();
      const { name } = registeredButUnstamped(mock, registry);
      const authority = new WorkspacePromotionAuthority({
        daemonInstanceId: DAEMON,
        registry,
        io: io(mock),
      });

      await authority.promote(request(fleetSessionIdForName(name)));

      // The workspace was admitted by another path (m32 open, or an earlier
      // promotion). Reconciliation repairs pane identity only; it must not
      // claim the session's provenance or rewrite its workspace name.
      const session = mock.sessionOf("$1")!;
      expect(session.options.has("@tmux_ide_workspace_promoted_v1")).toBe(false);
      expect(session.options.has("@tmux_ide_workspace_name")).toBe(false);
      expect(session.options.has("@tmux_ide_workspace_promote_operation")).toBe(false);
    });

    it("leaves an already-stamped registered session byte-identical", async () => {
      const mock = new MockTmux();
      const { name } = adoptedAgentSession(mock);
      const registry = new FakeRegistry();
      const authority = new WorkspacePromotionAuthority({
        daemonInstanceId: DAEMON,
        registry,
        io: io(mock),
      });

      const first = await authority.promote(request(fleetSessionIdForName(name)));
      const stamp = mock.paneOption("%1")!.options.get("@tmux_ide_pane_id");
      const second = await authority.promote(request(fleetSessionIdForName(name)));

      expect(second.outcome).toBe("replayed");
      expect(mock.paneOption("%1")!.options.get("@tmux_ide_pane_id")).toBe(stamp);
      expect(first.resource.workspaceName).toBe(second.resource.workspaceName);
    });

    it("surfaces a typed verdict when reconciliation cannot make the session attachable", async () => {
      const mock = new MockTmux();
      const registry = new FakeRegistry();
      const session = mock.session("fleet-collided", "$1", { "@tmux_ide_adopted": "1" });
      const window = mock.window(session, "@1", "split");
      // Two panes claiming ONE semantic identity: both stamps are locally valid,
      // so reconciliation preserves them and the catalog rejects the inventory.
      for (const paneId of ["%1", "%2"]) {
        mock.pane(window, paneId, {
          active: paneId === "%1",
          currentCommand: "zsh",
          options: { "@tmux_ide_pane_id": "pane.workspace.collision" },
        });
      }
      registry.add({
        name: "fleet-collided-existing",
        sessionName: "fleet-collided",
        projectDir: "/tmp/promote-project",
        ideConfigPath: null,
        configKind: "none",
        configPath: null,
        hasWorkspaceConfig: false,
      });
      const authority = new WorkspacePromotionAuthority({
        daemonInstanceId: DAEMON,
        registry,
        io: io(mock),
      });

      await expect(
        authority.promote(request(fleetSessionIdForName("fleet-collided"))),
      ).rejects.toMatchObject({
        code: "promotion_verification_failed",
        context: { reason: "semantic_pane_catalog_rejected_inventory" },
      });
    });
  });

  it("preserves an existing valid pane stamp and only stamps the unstamped pane", async () => {
    const mock = new MockTmux();
    const session = mock.session("fleet-mixed", "$1", { "@tmux_ide_adopted": "1" });
    const w1 = mock.window(session, "@1", "editor");
    mock.pane(w1, "%1", {
      active: true,
      currentCommand: "claude",
      options: {
        "@tmux_ide_pane_id": "pane.workspace.deadbeefdeadbeefdeadbeefdeadbeef",
        "@ide_type": "agent",
        "@ide_role": "lead",
        "@ide_name": "Existing",
      },
    });
    const w2 = mock.window(session, "@2", "shell");
    mock.pane(w2, "%2", { currentCommand: "zsh" });
    const registry = new FakeRegistry();
    const authority = new WorkspacePromotionAuthority({
      daemonInstanceId: DAEMON,
      registry,
      io: io(mock),
    });

    const result = await authority.promote(request(fleetSessionIdForName("fleet-mixed")));

    expect(result.outcome).toBe("promoted");
    // The valid stamp and its metadata are untouched.
    expect(mock.paneOption("%1")!.options.get("@tmux_ide_pane_id")).toBe(
      "pane.workspace.deadbeefdeadbeefdeadbeefdeadbeef",
    );
    expect(mock.paneOption("%1")!.options.get("@ide_role")).toBe("lead");
    // The unstamped shell pane gets a fresh stamp and shell defaults.
    expect(mock.paneOption("%2")!.options.get("@tmux_ide_pane_id")).toMatch(
      /^pane\.promoted\.[0-9a-f]{20}$/u,
    );
    expect(mock.paneOption("%2")!.options.get("@ide_type")).toBe("shell");
    expect(mock.paneOption("%2")!.options.get("@ide_name")).toBe("Terminal");
  });

  it("promotes a multi-pane window (attachability is left to the attach-time catalog)", async () => {
    const mock = new MockTmux();
    const session = mock.session("fleet-split", "$1", { "@tmux_ide_adopted": "1" });
    const window = mock.window(session, "@1", "split");
    mock.pane(window, "%1", { active: true, currentCommand: "zsh" });
    mock.pane(window, "%2", { currentCommand: "vim" });
    const registry = new FakeRegistry();
    const authority = new WorkspacePromotionAuthority({
      daemonInstanceId: DAEMON,
      registry,
      io: io(mock),
    });

    const result = await authority.promote(request(fleetSessionIdForName("fleet-split")));

    expect(result.outcome).toBe("promoted");
    expect(mock.paneOption("%1")!.options.get("@tmux_ide_pane_id")).toMatch(/^pane\.promoted\./u);
    expect(mock.paneOption("%2")!.options.get("@tmux_ide_pane_id")).toMatch(/^pane\.promoted\./u);
    // Distinct panes get distinct stamps within the same window.
    expect(mock.paneOption("%1")!.options.get("@tmux_ide_pane_id")).not.toBe(
      mock.paneOption("%2")!.options.get("@tmux_ide_pane_id"),
    );
    // Both panes share one window stamp.
    expect(mock.paneOption("%1")!.options.get("@tmux_ide_pane_id")).toBeDefined();
    expect(mock.windowOf("@1")!.window.options.get("@tmux_ide_window_id")).toMatch(
      /^window\.promoted\./u,
    );
    expect(registry.list()).toHaveLength(1);
  });

  it("sanitizes a hostile agent display name into a clean @ide_name", async () => {
    const mock = new MockTmux();
    const session = mock.session("fleet-hostile", "$1", { "@tmux_ide_adopted": "1" });
    const window = mock.window(session, "@1", "agent");
    mock.pane(window, "%1", {
      active: true,
      currentCommand: "claude",
      options: {
        "@agent_state": `working:${NOW_SEC}`,
        "@agent_display_name": "\u001b[31m\u0007Danger\u0001Bot\t\t",
      },
    });
    const registry = new FakeRegistry();
    const authority = new WorkspacePromotionAuthority({
      daemonInstanceId: DAEMON,
      registry,
      io: io(mock),
    });

    const result = await authority.promote(request(fleetSessionIdForName("fleet-hostile")));

    expect(result.outcome).toBe("promoted");
    const name = mock.paneOption("%1")!.options.get("@ide_name")!;
    expect(name.length).toBeGreaterThan(0);
    // No control characters or DEL survive into the durable stamp.
    expect([...name].every((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127)).toBe(true);
  });

  it("rejects an unknown fleet session id as session_not_found", async () => {
    const mock = new MockTmux();
    adoptedAgentSession(mock);
    const authority = new WorkspacePromotionAuthority({
      daemonInstanceId: DAEMON,
      registry: new FakeRegistry(),
      io: io(mock),
    });
    await expect(
      authority.promote(request(fleetSessionIdForName("no-such-session"))),
    ).rejects.toMatchObject({ code: "session_not_found" });
  });

  it("rejects a non-adopted session as session_not_adopted", async () => {
    const mock = new MockTmux();
    const session = mock.session("fleet-unadopted", "$1");
    const window = mock.window(session, "@1", "shell");
    mock.pane(window, "%1", { active: true });
    const authority = new WorkspacePromotionAuthority({
      daemonInstanceId: DAEMON,
      registry: new FakeRegistry(),
      io: io(mock),
    });
    await expect(
      authority.promote(request(fleetSessionIdForName("fleet-unadopted"))),
    ).rejects.toMatchObject({ code: "session_not_adopted" });
  });

  it("refuses to promote an internal session", async () => {
    const mock = new MockTmux();
    const session = mock.session("zz-scratch", "$1", { "@tmux_ide_adopted": "1" });
    const window = mock.window(session, "@1", "shell");
    mock.pane(window, "%1", { active: true });
    const authority = new WorkspacePromotionAuthority({
      daemonInstanceId: DAEMON,
      registry: new FakeRegistry(),
      io: io(mock),
    });
    await expect(
      authority.promote(request(fleetSessionIdForName("zz-scratch"))),
    ).rejects.toMatchObject({ code: "session_internal" });
  });

  it("rejects a daemon generation mismatch", async () => {
    const mock = new MockTmux();
    const { name } = adoptedAgentSession(mock);
    const authority = new WorkspacePromotionAuthority({
      daemonInstanceId: DAEMON,
      registry: new FakeRegistry(),
      io: io(mock),
    });
    await expect(
      authority.promote(
        request(fleetSessionIdForName(name), {
          expectedDaemonInstanceId: "30000000-0000-4000-8000-000000000003",
        }),
      ),
    ).rejects.toMatchObject({ code: "daemon_instance_mismatch" });
  });

  it("rejects a reused operation id carrying a different intent", async () => {
    const mock = new MockTmux();
    adoptedAgentSession(mock, "fleet-a");
    const other = mock.session("fleet-b", "$2", { "@tmux_ide_adopted": "1" });
    const window = mock.window(other, "@2", "shell");
    mock.pane(window, "%2", { active: true });
    const registry = new FakeRegistry();
    const authority = new WorkspacePromotionAuthority({
      daemonInstanceId: DAEMON,
      registry,
      io: io(mock),
    });
    const operationId = randomUUID();
    await authority.promote(request(fleetSessionIdForName("fleet-a"), { operationId }));
    await expect(
      authority.promote(request(fleetSessionIdForName("fleet-b"), { operationId })),
    ).rejects.toMatchObject({ code: "operation_conflict" });
  });

  it("leaves the session harmless when stamping fails mid-flight (no registry entry)", async () => {
    const mock = new MockTmux();
    const { name } = adoptedAgentSession(mock);
    const registry = new FakeRegistry();
    let calls = 0;
    const failingRun: WorkspacePromotionIo["runTmux"] = (args) => {
      if (args[0] === "set-option") {
        calls += 1;
        if (calls === 1) throw new TmuxError("boom", "TMUX_UNAVAILABLE");
      }
      return mock.run(args);
    };
    const authority = new WorkspacePromotionAuthority({
      daemonInstanceId: DAEMON,
      registry,
      io: io(mock, { runTmux: failingRun }),
    });

    await expect(authority.promote(request(fleetSessionIdForName(name)))).rejects.toBeInstanceOf(
      WorkspacePromotionError,
    );
    // Additive-failure contract: no registry admission on a mid-flight failure.
    expect(registry.list()).toHaveLength(0);
  });

  // Real fleets constantly contain panes whose cwd is a DELETED directory (a
  // pruned git worktree). A dead pane cwd must never block promotion; the
  // project root resolves from the first live candidate instead.
  describe("project directory resolution across dead cwds", () => {
    const created: string[] = [];
    const liveDir = (): string => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "promote-cwd-")));
      created.push(dir);
      return dir;
    };
    const deadDir = (): string => join(tmpdir(), `promote-pruned-${randomUUID()}`);
    const realCanonical = (path: string): string => {
      const canonical = realpathSync(path);
      if (!statSync(canonical).isDirectory()) throw new Error("project root is not a directory");
      return canonical;
    };
    afterEach(() => {
      while (created.length > 0) rmSync(created.pop()!, { recursive: true, force: true });
    });

    it("(a) resolves the tmux session_path when a pane cwd is a deleted directory", async () => {
      const root = liveDir();
      const mock = new MockTmux();
      const session = mock.session("fleet-live-root", "$1", { "@tmux_ide_adopted": "1" }, root);
      const window = mock.window(session, "@1", "editor");
      mock.pane(window, "%1", { active: true, currentPath: deadDir(), currentCommand: "claude" });
      const registry = new FakeRegistry();
      const authority = new WorkspacePromotionAuthority({
        daemonInstanceId: DAEMON,
        registry,
        io: io(mock, { canonicalProjectDir: realCanonical }),
      });

      const result = await authority.promote(request(fleetSessionIdForName("fleet-live-root")));

      expect(result.outcome).toBe("promoted");
      expect(registry.list()[0]!.projectDir).toBe(root);
    });

    it("(b) falls back to the first live pane cwd when session_path is dead", async () => {
      const paneDir = liveDir();
      const mock = new MockTmux();
      const session = mock.session(
        "fleet-dead-root",
        "$1",
        { "@tmux_ide_adopted": "1" },
        deadDir(),
      );
      const window = mock.window(session, "@1", "split");
      // The active pane's cwd is dead too; a later pane still lives.
      mock.pane(window, "%1", { active: true, currentPath: deadDir(), currentCommand: "zsh" });
      mock.pane(window, "%2", { currentPath: paneDir, currentCommand: "vim" });
      const registry = new FakeRegistry();
      const authority = new WorkspacePromotionAuthority({
        daemonInstanceId: DAEMON,
        registry,
        io: io(mock, { canonicalProjectDir: realCanonical }),
      });

      const result = await authority.promote(request(fleetSessionIdForName("fleet-dead-root")));

      expect(result.outcome).toBe("promoted");
      expect(registry.list()[0]!.projectDir).toBe(paneDir);
    });

    it("(c) fails project_directory_unavailable only when nothing resolves", async () => {
      const mock = new MockTmux();
      const session = mock.session("fleet-all-dead", "$1", { "@tmux_ide_adopted": "1" }, deadDir());
      const window = mock.window(session, "@1", "editor");
      mock.pane(window, "%1", { active: true, currentPath: deadDir(), currentCommand: "zsh" });
      const registry = new FakeRegistry();
      const authority = new WorkspacePromotionAuthority({
        daemonInstanceId: DAEMON,
        registry,
        io: io(mock, { canonicalProjectDir: realCanonical }),
      });

      await expect(
        authority.promote(request(fleetSessionIdForName("fleet-all-dead"))),
      ).rejects.toMatchObject({
        code: "promotion_verification_failed",
        context: { reason: "project_directory_unavailable" },
      });
      // Nothing resolved -> harmless: no registry admission.
      expect(registry.list()).toHaveLength(0);
    });
  });
});
