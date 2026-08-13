import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { realpath, stat } from "node:fs/promises";
import type {
  FleetAgentMutateArguments,
  FleetAgentMutateResult,
  FleetAgentProvisionArguments,
  FleetAgentProvisionResult,
  WorkspaceSessionCreateArguments,
  WorkspaceSessionCreateResult,
} from "@tmux-ide/contracts";
import type { WorkspaceRegistry } from "./workspace-registry.ts";
import { readAdoptedFleet } from "../command-center/discovery.ts";
import type { FleetSessionFacts } from "../command-center/discovery.ts";
import {
  fleetAgentIdForPane,
  fleetCatalogRevisionForFacts,
  fleetSessionIdForName,
  projectFleetCatalog,
} from "../command-center/resources/fleet-catalog.ts";
import { adoptMarkArgv, updaterProbeArgv, updaterSpawnArgv } from "./chrome-front-door.ts";
import {
  INTERRUPT_TAP_GAP_MS,
  RESTART_GRACE_MS,
  clearAuthorityArgs,
  interruptArgs,
  launchCommandForHarness,
  paneStartHostsShell,
  relaunchArgs,
  respawnArgs,
} from "./fleet-agent-lifecycle.ts";

const MAX_REPLAY_OPERATIONS = 128;
const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export class FleetLifecycleAuthorityError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class FleetLifecycleAuthority {
  readonly #daemonInstanceId: string;
  readonly #productVersion: string;
  readonly #startedAt: string;
  readonly #registry: Pick<WorkspaceRegistry, "list" | "add">;
  readonly #runTmux: (args: readonly string[]) => string;
  readonly #readFleet: () => FleetSessionFacts[] | null;
  readonly #operations = new Map<string, { fingerprint: string; result: unknown }>();
  #tail: Promise<void> = Promise.resolve();

  constructor(options: {
    daemonInstanceId: string;
    productVersion: string;
    startedAt: string;
    registry: Pick<WorkspaceRegistry, "list" | "add">;
    runTmux: (args: readonly string[]) => string;
    readFleet?: () => FleetSessionFacts[] | null;
  }) {
    this.#daemonInstanceId = options.daemonInstanceId;
    this.#productVersion = options.productVersion;
    this.#startedAt = options.startedAt;
    this.#registry = options.registry;
    this.#runTmux = options.runTmux;
    this.#readFleet = options.readFleet ?? (() => readAdoptedFleet(this.#registry));
  }

  createSession(
    operationId: string,
    generation: string,
    input: WorkspaceSessionCreateArguments,
  ): Promise<WorkspaceSessionCreateResult> {
    return this.#exclusive(() => this.#createSession(operationId, generation, input));
  }

  async #createSession(
    operationId: string,
    generation: string,
    input: WorkspaceSessionCreateArguments,
  ): Promise<WorkspaceSessionCreateResult> {
    this.#assertGeneration(generation);
    const fingerprint = JSON.stringify(["create", input]);
    const replay = this.#replay<WorkspaceSessionCreateResult>(operationId, fingerprint);
    if (replay) return { ...replay, outcome: "replayed" };
    const cwd = await this.#canonicalDir(input.cwd ?? process.cwd());
    const identity = this.#sessionIdentity(input.displayName, cwd);
    const existing = this.#registry
      .list()
      .find(
        (workspace) =>
          workspace.name === identity.workspaceName ||
          workspace.sessionName === identity.sessionName,
      );
    if (existing) {
      let existingCwd: string;
      try {
        existingCwd = await this.#canonicalDir(existing.projectDir);
      } catch {
        throw new FleetLifecycleAuthorityError(
          "workspace_conflict",
          "The registered workspace directory is unavailable.",
        );
      }
      if (existingCwd !== cwd)
        throw new FleetLifecycleAuthorityError(
          "workspace_conflict",
          "The requested session identity is already registered for another directory.",
        );
      try {
        this.#runTmux(["has-session", "-t", `=${existing.sessionName}`]);
        const result: WorkspaceSessionCreateResult = {
          operationId,
          daemonInstanceId: this.#daemonInstanceId,
          outcome: "adopted",
          fleetSessionId: fleetSessionIdForName(existing.sessionName),
          workspaceName: existing.name,
          displayName: input.displayName,
        };
        this.#remember(operationId, fingerprint, result);
        return result;
      } catch {
        // Durable intent outlived tmux. Recreate the same canonical route below.
      }
    }
    let created = false;
    try {
      this.#runTmux(["new-session", "-d", "-s", identity.sessionName, "-c", cwd]);
      created = true;
      this.#runTmux(["set-environment", "-t", identity.sessionName, "TMUX_IDE", "1"]);
      this.#runTmux(adoptMarkArgv(identity.sessionName));
      try {
        this.#runTmux(updaterProbeArgv());
      } catch {
        this.#runTmux(updaterSpawnArgv());
      }
      if (!existing)
        this.#registry.add({
          name: identity.workspaceName,
          sessionName: identity.sessionName,
          projectDir: cwd,
          ideConfigPath: null,
          configKind: "none",
          configPath: null,
          hasWorkspaceConfig: false,
        });
    } catch (error) {
      if (created)
        try {
          this.#runTmux(["kill-session", "-t", identity.sessionName]);
        } catch {
          /* best effort rollback */
        }
      throw error;
    }
    const result: WorkspaceSessionCreateResult = {
      operationId,
      daemonInstanceId: this.#daemonInstanceId,
      outcome: "created",
      fleetSessionId: fleetSessionIdForName(identity.sessionName),
      workspaceName: identity.workspaceName,
      displayName: input.displayName,
    };
    this.#remember(operationId, fingerprint, result);
    return result;
  }

  mutateAgent(
    operationId: string,
    generation: string,
    input: FleetAgentMutateArguments,
  ): Promise<FleetAgentMutateResult> {
    return this.#exclusive(() => this.#mutateAgent(operationId, generation, input));
  }

  async #mutateAgent(
    operationId: string,
    generation: string,
    input: FleetAgentMutateArguments,
  ): Promise<FleetAgentMutateResult> {
    this.#assertGeneration(generation);
    const fingerprint = JSON.stringify(["agent", input]);
    const replay = this.#replay<FleetAgentMutateResult>(operationId, fingerprint);
    if (replay) return { ...replay, outcome: "replayed" };
    const facts = this.#requireFleet();
    const resource = projectFleetCatalog(
      facts,
      {
        protocolVersion: 1,
        productVersion: this.#productVersion,
        instanceId: this.#daemonInstanceId,
        startedAt: this.#startedAt,
      },
      Math.floor(Date.now() / 1000),
    );
    const revision = fleetCatalogRevisionForFacts(facts);
    if (revision !== input.expectedCatalogRevision)
      throw new FleetLifecycleAuthorityError(
        "catalog_changed",
        "Fleet catalog changed; refresh and retry.",
      );
    const session = facts.find((item) => fleetSessionIdForName(item.name) === input.fleetSessionId);
    const pane = session?.panes.find(
      (item) => fleetAgentIdForPane(session.name, item) === input.agentId,
    );
    if (!session || !pane)
      throw new FleetLifecycleAuthorityError(
        "agent_not_found",
        "Agent identity is no longer live.",
      );
    if (input.mutation === "stop") await this.#stopAgent(pane.runtimePaneId);
    else if (input.mutation === "restart") {
      const catalogSession = resource.sessions.find(
        (item) => item.sessionId === input.fleetSessionId,
      )!;
      const catalogAgent = catalogSession.agents.find((item) => item.agentId === input.agentId)!;
      await this.#restartAgent(pane.runtimePaneId, launchCommandForHarness(catalogAgent.harness));
    } else this.#runTmux(["kill-pane", "-t", pane.runtimePaneId]);
    const result: FleetAgentMutateResult = {
      operationId,
      daemonInstanceId: this.#daemonInstanceId,
      outcome: "applied",
      fleetSessionId: input.fleetSessionId,
      agentId: input.agentId,
      catalogRevision: revision,
      mutation: input.mutation,
    };
    this.#remember(operationId, fingerprint, result);
    return result;
  }

  provisionAgent(
    operationId: string,
    generation: string,
    input: FleetAgentProvisionArguments,
  ): Promise<FleetAgentProvisionResult> {
    return this.#exclusive(() => this.#provisionAgent(operationId, generation, input));
  }

  async #provisionAgent(
    operationId: string,
    generation: string,
    input: FleetAgentProvisionArguments,
  ): Promise<FleetAgentProvisionResult> {
    this.#assertGeneration(generation);
    const fingerprint = JSON.stringify(["provision", input]);
    const replay = this.#replay<FleetAgentProvisionResult>(operationId, fingerprint);
    if (replay) return { ...replay, outcome: "replayed" };

    const before = this.#requireFleet();
    if (fleetCatalogRevisionForFacts(before) !== input.expectedCatalogRevision)
      throw new FleetLifecycleAuthorityError(
        "catalog_changed",
        "Fleet catalog changed; refresh and retry.",
      );

    let sessionName: string;
    let workspaceName: string;
    let cwd: string;
    let paneId: string;
    let createdSession = false;
    if (input.target.kind === "new-session") {
      cwd = await this.#canonicalDir(input.target.cwd);
      const identity = this.#sessionIdentity(input.target.displayName, cwd);
      sessionName = identity.sessionName;
      workspaceName = identity.workspaceName;
      if (this.#registry.list().some((workspace) => workspace.sessionName === sessionName))
        throw new FleetLifecycleAuthorityError(
          "workspace_conflict",
          "The requested session already exists.",
        );
      paneId = this.#runTmux([
        "new-session",
        "-d",
        "-s",
        sessionName,
        "-P",
        "-F",
        "#{pane_id}",
        "-c",
        cwd,
        input.command,
      ]).trim();
      createdSession = true;
      this.#runTmux(["set-environment", "-t", sessionName, "TMUX_IDE", "1"]);
      this.#runTmux(adoptMarkArgv(sessionName));
    } else {
      const target = input.target;
      const session = before.find(
        (item) => fleetSessionIdForName(item.name) === target.fleetSessionId,
      );
      if (!session)
        throw new FleetLifecycleAuthorityError(
          "session_not_found",
          "Fleet session is no longer live.",
        );
      sessionName = session.name;
      workspaceName =
        this.#registry.list().find((workspace) => workspace.sessionName === sessionName)?.name ??
        sessionName;
      const targetPane = target.targetSemanticPaneId
        ? session.panes.find((pane) => pane.semanticPaneId === target.targetSemanticPaneId)
        : undefined;
      if (target.placement !== "window" && !targetPane)
        throw new FleetLifecycleAuthorityError("pane_not_found", "Target pane is no longer live.");
      cwd = target.inheritTargetCwd
        ? targetPane!.currentPath
        : await this.#canonicalDir(target.cwd ?? session.cwd);
      const command =
        target.placement === "window"
          ? ["new-window", "-t", `${sessionName}:`, "-P", "-F", "#{pane_id}"]
          : [
              "split-window",
              target.placement === "split-h" ? "-h" : "-v",
              "-t",
              targetPane!.runtimePaneId,
              "-P",
              "-F",
              "#{pane_id}",
            ];
      paneId = this.#runTmux([...command, "-c", cwd, input.command]).trim();
      this.#runTmux(adoptMarkArgv(sessionName));
    }

    if (!/^%[0-9]+$/u.test(paneId)) {
      if (createdSession) this.#tryTmux(["kill-session", "-t", sessionName]);
      throw new FleetLifecycleAuthorityError(
        "spawn_failed",
        "tmux did not return a pane identity.",
      );
    }
    const semanticPaneId = `pane.agent.${randomUUID()}`;
    try {
      this.#runTmux(["set-option", "-p", "-t", paneId, "@tmux_ide_pane_id", semanticPaneId]);
      this.#runTmux(["set-option", "-p", "-t", paneId, "@agent_launch", input.command]);
      this.#runTmux(["set-option", "-p", "-t", paneId, "@agent_hint", input.harness]);
      this.#runTmux(["select-pane", "-t", paneId, "-T", input.displayTitle]);
      try {
        this.#runTmux(updaterProbeArgv());
      } catch {
        this.#runTmux(updaterSpawnArgv());
      }
    } catch (error) {
      if (createdSession) this.#tryTmux(["kill-session", "-t", sessionName]);
      else this.#tryTmux(["kill-pane", "-t", paneId]);
      throw error;
    }
    const after = this.#requireFleet();
    const sessionFacts = after.find((item) => item.name === sessionName);
    const paneFacts = sessionFacts?.panes.find((pane) => pane.semanticPaneId === semanticPaneId);
    if (!sessionFacts || !paneFacts) {
      if (createdSession) this.#tryTmux(["kill-session", "-t", sessionName]);
      else this.#tryTmux(["kill-pane", "-t", paneId]);
      throw new FleetLifecycleAuthorityError(
        "spawn_unconfirmed",
        "Spawned pane was not confirmed.",
      );
    }
    if (createdSession)
      try {
        this.#registry.add({
          name: workspaceName,
          sessionName,
          projectDir: cwd,
          ideConfigPath: null,
          configKind: "none",
          configPath: null,
          hasWorkspaceConfig: false,
        });
      } catch (error) {
        this.#tryTmux(["kill-session", "-t", sessionName]);
        throw error;
      }
    const result: FleetAgentProvisionResult = {
      operationId,
      daemonInstanceId: this.#daemonInstanceId,
      outcome: "created",
      fleetSessionId: fleetSessionIdForName(sessionName),
      agentId: fleetAgentIdForPane(sessionName, paneFacts),
      catalogRevision: fleetCatalogRevisionForFacts(after),
      workspaceName,
    };
    this.#remember(operationId, fingerprint, result);
    return result;
  }

  async #exclusive<T>(run: () => Promise<T>): Promise<T> {
    const predecessor = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      return await run();
    } finally {
      release();
    }
  }

  #assertGeneration(generation: string): void {
    if (generation !== this.#daemonInstanceId)
      throw new FleetLifecycleAuthorityError("generation_mismatch", "Daemon generation changed.");
  }

  #requireFleet(): FleetSessionFacts[] {
    const fleet = this.#readFleet();
    if (fleet === null)
      throw new FleetLifecycleAuthorityError(
        "fleet_unavailable",
        "Fleet observation is unavailable; refresh and retry.",
      );
    return fleet;
  }
  #replay<T>(operationId: string, fingerprint: string): T | null {
    const prior = this.#operations.get(operationId);
    if (!prior) return null;
    if (prior.fingerprint !== fingerprint)
      throw new FleetLifecycleAuthorityError("operation_conflict", "Operation id was reused.");
    return prior.result as T;
  }
  #remember(operationId: string, fingerprint: string, result: unknown): void {
    while (this.#operations.size >= MAX_REPLAY_OPERATIONS) {
      const oldest = this.#operations.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#operations.delete(oldest);
    }
    this.#operations.set(operationId, { fingerprint, result });
  }
  #tryTmux(args: readonly string[]): void {
    try {
      this.#runTmux(args);
    } catch {
      /* pane disappearance is an ordinary race */
    }
  }
  #paneStartAndPath(paneId: string): { start: string; path: string } {
    let output: string;
    try {
      output = this.#runTmux([
        "display-message",
        "-p",
        "-t",
        paneId,
        "#{pane_start_command}\t#{pane_current_path}",
      ]);
    } catch {
      throw new FleetLifecycleAuthorityError("agent_not_found", "Agent pane disappeared.");
    }
    const [start = "", path = ""] = output.split("\t");
    return { start, path };
  }
  async #stopAgent(paneId: string): Promise<void> {
    this.#paneStartAndPath(paneId);
    this.#tryTmux(interruptArgs(paneId));
    await sleep(INTERRUPT_TAP_GAP_MS);
    this.#tryTmux(interruptArgs(paneId));
    for (const args of clearAuthorityArgs(paneId)) this.#tryTmux(args);
  }
  async #restartAgent(paneId: string, command: string): Promise<void> {
    const live = this.#paneStartAndPath(paneId);
    if (paneStartHostsShell(live.start)) {
      await this.#stopAgent(paneId);
      await sleep(RESTART_GRACE_MS);
      for (const args of relaunchArgs(paneId, command)) this.#tryTmux(args);
      return;
    }
    for (const args of clearAuthorityArgs(paneId)) this.#tryTmux(args);
    this.#tryTmux(respawnArgs(paneId, command, live.path || null));
  }
  async #canonicalDir(value: string): Promise<string> {
    if (!isAbsolute(value))
      throw new FleetLifecycleAuthorityError("invalid_path", "cwd must be absolute");
    const canonical = await realpath(resolve(value));
    if (!(await stat(canonical)).isDirectory())
      throw new FleetLifecycleAuthorityError("invalid_path", "cwd must be a directory");
    return canonical;
  }
  #sessionIdentity(
    displayName: string,
    cwd: string,
  ): { workspaceName: string; sessionName: string } {
    const slug =
      displayName
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/gu, "")
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/gu, "-")
        .replace(/-+/gu, "-")
        .replace(/^[-_]+|[-_]+$/gu, "")
        .slice(0, 56) || "session";
    const key = createHash("sha256")
      .update("tmux-ide.workspace.session.create.v1\0", "utf8")
      .update(displayName, "utf8")
      .update("\0", "utf8")
      .update(cwd, "utf8")
      .digest("hex")
      .slice(0, 20);
    const workspaceName = `${slug}-${key}`;
    return { workspaceName, sessionName: workspaceName };
  }
}
