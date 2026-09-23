import { randomUUID } from "node:crypto";
import {
  SavedMachineSchema,
  TmuxServerIdSchemaZ,
  TmuxServerRegistrationRequestSchemaZ,
  WorkspaceSessionCreateArgumentsSchemaZ,
  type TmuxServerRegistrationRequest,
} from "@tmux-ide/contracts";
import {
  createTmuxServerClient,
  listTmuxServers,
  registerTmuxServer,
  removeTmuxServer,
  TmuxServerClientError,
  type TmuxServerClientOptions,
} from "@tmux-ide/daemon-client/tmux-server-client";
import { canonicalDaemonUrl } from "./canonical-daemon.ts";
import { ensureCanonicalDaemon } from "./canonical-daemon-bootstrap.ts";
import { openSshDaemonTransport } from "./ssh-daemon-transport.ts";
import { loadSavedMachines } from "./saved-machines.ts";

export interface TmuxServersCliOptions {
  readonly command?: string;
  readonly serverId?: string;
  readonly socketName?: string;
  readonly socketPath?: string;
  readonly label?: string;
  readonly sessionName?: string;
  readonly cwd?: string;
  readonly ssh?: string;
}
type Operation =
  | { command: "list" }
  | { command: "add"; registration: TmuxServerRegistrationRequest }
  | { command: "remove" | "sessions"; serverId: string }
  | { command: "create"; serverId: string; input: { displayName: string; cwd?: string } };

/** Parse before acquiring a transport; invalid input cannot start a daemon. */
export function parseTmuxServersOperation(options: TmuxServersCliOptions): Operation {
  const command = options.command ?? "list";
  if (options.ssh !== undefined) SavedMachineSchema.shape.sshTarget.parse(options.ssh);
  if (command === "create") {
    if (
      options.socketName !== undefined ||
      options.socketPath !== undefined ||
      options.label !== undefined
    )
      throw new Error("servers create requires a registered server ID and --session-name NAME");
    return {
      command,
      serverId: TmuxServerIdSchemaZ.parse(options.serverId),
      input: WorkspaceSessionCreateArgumentsSchemaZ.parse({
        displayName: options.sessionName,
        ...(options.cwd ? { cwd: options.cwd } : {}),
      }),
    };
  }
  if (options.sessionName !== undefined || options.cwd !== undefined)
    throw new Error("--session-name and --dir are only supported by servers create");
  if (command === "add") {
    if (
      options.serverId ||
      (options.socketName === undefined) === (options.socketPath === undefined)
    )
      throw new Error(
        "servers add requires exactly one of --socket-name NAME or --socket-path /PATH",
      );
    return {
      command,
      registration: TmuxServerRegistrationRequestSchemaZ.parse({
        label: options.label ?? options.socketName ?? "Custom server",
        selector:
          options.socketName !== undefined
            ? { kind: "name", name: options.socketName }
            : { kind: "path", path: options.socketPath },
      }),
    };
  }
  if (
    options.socketName !== undefined ||
    options.socketPath !== undefined ||
    options.label !== undefined
  )
    throw new Error("Socket selectors and --name are only supported by servers add");
  if (command === "list" && options.serverId === undefined) return { command };
  if (command === "remove" || command === "sessions")
    return { command, serverId: TmuxServerIdSchemaZ.parse(options.serverId) };
  throw new Error(
    "Usage: tmux-ide servers list|add|remove <server-id>|sessions <server-id>|create <server-id> --session-name NAME [--ssh HOST] [--json]",
  );
}

export interface TmuxServersCliConnection {
  readonly client: TmuxServerClientOptions;
  dispose(): void;
}
export async function connectTmuxServersCli(options: {
  readonly ssh?: string;
  readonly entryPath: string;
  readonly expectedProductVersion?: string;
}): Promise<TmuxServersCliConnection> {
  const hostClientId = randomUUID();
  if (options.ssh !== undefined) {
    const transport = await openSshDaemonTransport({ alias: options.ssh });
    try {
      const expected = loadSavedMachines().machines.find(
        (machine) => machine.sshTarget === options.ssh,
      )?.expectedEnvironmentId;
      if (expected && transport.daemon.environmentId !== expected)
        throw new Error("SSH route reached a different environment than the saved profile");
      return {
        client: {
          baseUrl: transport.baseUrl,
          ownerToken: transport.daemon.authToken,
          hostClientId,
          origin: transport.baseUrl,
        },
        dispose: () => transport.dispose(),
      };
    } catch (error) {
      transport.dispose();
      throw error;
    }
  }
  // Server registration addresses the daemon, not the invoking shell's tmux server.
  const { candidate } = await ensureCanonicalDaemon({
    entryPath: options.entryPath,
    expectedProductVersion: options.expectedProductVersion,
    tmuxServerIntent: null,
  });
  if (!candidate.authToken)
    throw new Error("Daemon owner authority is unavailable; update the local daemon");
  const baseUrl = canonicalDaemonUrl("http", candidate.bindHostname, candidate.port);
  return {
    client: { baseUrl, ownerToken: candidate.authToken, hostClientId, origin: baseUrl },
    dispose() {},
  };
}

export async function runTmuxServersCli(
  options: TmuxServersCliOptions,
  connect: () => Promise<TmuxServersCliConnection>,
): Promise<unknown> {
  const operation = parseTmuxServersOperation(options);
  const connection = await connect();
  try {
    // Probe the versioned resource before writes. An older daemon is unsupported,
    // never a reason to execute a raw command against a default server.
    let catalog;
    try {
      catalog = await listTmuxServers(connection.client);
    } catch (error) {
      if (error instanceof TmuxServerClientError && [404, 405, 426].includes(error.status ?? 0))
        throw new Error(
          "This daemon does not support tmux server selection; update the selected machine's daemon",
          { cause: error },
        );
      throw error;
    }
    if (operation.command === "list") return catalog;
    if (operation.command === "add")
      return await registerTmuxServer(connection.client, operation.registration);
    const server = catalog.servers.find((candidate) => candidate.serverId === operation.serverId);
    if (!server)
      throw new Error("Selected tmux server is not registered; run tmux-ide servers list");
    if (operation.command === "remove") {
      await removeTmuxServer(connection.client, server.serverId);
      return { removed: true, serverId: server.serverId };
    }
    if (server.state !== "online")
      throw new Error("Selected tmux server is offline; no session operation was attempted");
    const client = createTmuxServerClient(connection.client, {
      serverId: server.serverId,
      generation: server.generation,
    });
    try {
      return operation.command === "create"
        ? await client.createSession(randomUUID(), operation.input)
        : await client.sessions();
    } finally {
      client.dispose();
    }
  } finally {
    connection.dispose();
  }
}
