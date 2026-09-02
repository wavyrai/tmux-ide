import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { openPaneStreamRuntimeClient } from "@tmux-ide/daemon-client/pane-stream-client";
import { dispatchOwnerAction } from "@tmux-ide/daemon-client/owner-action-client";
import type { SessionRuntimeAuthoritySnapshot } from "@tmux-ide/contracts";

import { createOpenTuiPaneStreamSocket } from "../packages/daemon/src/tui/mirror/open-tui-pane-stream-socket.ts";

const baseUrl = required("TMUX_IDE_RIG_BASE_URL");
const ownerToken = required("TMUX_IDE_RIG_OWNER_TOKEN");
const generation = required("TMUX_IDE_RIG_GENERATION");
const workspaceName = required("TMUX_IDE_RIG_WORKSPACE");
const pane = required("TMUX_IDE_RIG_PANE");
const panes = requiredPaneInventory("TMUX_IDE_RIG_PANES", pane);
const session = required("TMUX_IDE_RIG_SESSION");
const sessionId = required("TMUX_IDE_RIG_SESSION_ID");
const socketPath = required("TMUX_IDE_RIG_TMUX_SOCKET");
const webOrigin = required("TMUX_IDE_RIG_WEB_ORIGIN");
const previousGeneration = process.env.TMUX_IDE_RIG_PREVIOUS_GENERATION ?? null;
const startedAt = performance.now();
const timings: Record<string, number> = {};
const snapshots = new Map<string, SessionRuntimeAuthoritySnapshot>();
const geometryOwnersSeen = new Map<string, Array<string | null>>();
const terminalDeliveries = new Map<string, number>();
const clients = [];
let nativeClient: ReturnType<typeof spawn> | null = null;

interface TmuxClientInventoryEntry {
  controlMode: boolean;
  pid: number;
  session: string;
  tty: string;
}

interface NativeClientDiagnostics {
  attempt: number;
  exit: { exitCode: number | null; signal: NodeJS.Signals | null } | null;
  output: string;
  processPid: number;
  ptyPid: number | null;
  tmuxClients: TmuxClientInventoryEntry[];
}

function elapsed(): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

async function waitFor(detail: string, predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${detail}`);
}

async function connect(name: "web-a" | "web-b" | "opentui") {
  const connectedAt = performance.now();
  const client = await openPaneStreamRuntimeClient({
    baseUrl,
    ownerToken,
    daemonInstanceId: generation,
    origin: name === "opentui" ? "tmux-ide://opentui" : webOrigin,
    hostClientId: `product-rig:${name}`,
    requestId: randomUUID(),
    stream: {
      protocolVersion: 1,
      workspaceName,
      panes,
      viewerMode: "interactive",
      terminalDelivery: {
        protocolVersions: [1],
        encodings: ["semantic-v1"],
        richPlacements: false,
      },
    },
    createSocket: createOpenTuiPaneStreamSocket,
    onNegotiated: () => undefined,
    onTerminalDelivery: () => terminalDeliveries.set(name, (terminalDeliveries.get(name) ?? 0) + 1),
    onAuthoritySnapshot: (snapshot) => {
      snapshots.set(name, snapshot);
      const history = geometryOwnersSeen.get(name) ?? [];
      history.push(snapshot.owners.geometry);
      geometryOwnersSeen.set(name, history);
    },
  });
  timings[`${name}.connectMs`] = Math.round((performance.now() - connectedAt) * 100) / 100;
  clients.push(client);
  return client;
}

async function proveGenerationFence(): Promise<void> {
  if (!previousGeneration || previousGeneration === generation) return;
  let staleClient: Awaited<ReturnType<typeof openPaneStreamRuntimeClient>> | null = null;
  try {
    staleClient = await openPaneStreamRuntimeClient({
      baseUrl,
      ownerToken,
      daemonInstanceId: previousGeneration,
      origin: webOrigin,
      hostClientId: "product-rig:stale-generation",
      requestId: randomUUID(),
      stream: {
        protocolVersion: 1,
        workspaceName,
        panes: [pane],
        viewerMode: "interactive",
        terminalDelivery: {
          protocolVersions: [1],
          encodings: ["semantic-v1"],
          richPlacements: false,
        },
      },
      createSocket: createOpenTuiPaneStreamSocket,
      onNegotiated: () => undefined,
      onTerminalDelivery: () => undefined,
    });
  } catch {
    return;
  } finally {
    staleClient?.close();
  }
  throw new Error("previous daemon generation was allowed to mint a pane stream");
}

function capture(): string {
  const paneIds = execFileSync(
    "tmux",
    ["-S", socketPath, "list-panes", "-s", "-t", `=${session}`, "-F", "#{pane_id}"],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  return paneIds
    .map((paneId) =>
      execFileSync(
        "tmux",
        ["-S", socketPath, "capture-pane", "-p", "-J", "-t", paneId, "-S", "-80"],
        { encoding: "utf8" },
      ),
    )
    .join("\n");
}

async function echo(name: string, client: Awaited<ReturnType<typeof connect>>): Promise<void> {
  const token = `RIG_${name.toUpperCase().replaceAll("-", "_")}_${randomUUID().slice(0, 8)}`;
  const handoffAt = performance.now();
  const lease = await client.requestAuthority("input");
  if (!lease || lease.clientId !== `product-rig:${name}`) throw new Error(`${name} lacks input`);
  client.sendText(pane, `printf '${token}\\n'`);
  client.sendKey(pane, "Enter");
  await waitFor(`${name} byte echo`, () => capture().includes(token));
  timings[`${name}.handoffEchoMs`] = Math.round((performance.now() - handoffAt) * 100) / 100;
  const snapshot = client.authoritySnapshot;
  if (snapshot?.owners.input !== `product-rig:${name}`) {
    throw new Error(`${name} executable input disagrees with authority snapshot`);
  }
}

async function proveAtomicPrepareCommit(): Promise<void> {
  const before = new Map(terminalDeliveries);
  const started = performance.now();
  const prepared = await dispatchOwnerAction({
    baseUrl,
    ownerToken,
    name: "workspace.open.prepare",
    input: {
      source: { kind: "live-session", sessionId },
      previousWorkspaceName: workspaceName,
    },
    operationId: randomUUID(),
    hostClientId: "product-rig:web-a",
    timeoutMs: 5_000,
  });
  if (!prepared || prepared.phase !== "prepared") throw new Error("workspace prepare failed");
  for (const name of ["web-a", "web-b", "opentui"] as const) {
    if (snapshots.get(name)?.generation !== generation) {
      throw new Error(`${name} lost its coherent generation during prepare`);
    }
    if ((terminalDeliveries.get(name) ?? 0) < (before.get(name) ?? 0)) {
      throw new Error(`${name} terminal frame regressed during prepare`);
    }
  }
  const committed = await dispatchOwnerAction({
    baseUrl,
    ownerToken,
    name: "workspace.open.commit",
    input: {
      prepareToken: prepared.prepareToken,
      preparedRevision: prepared.preparedRevision,
    },
    operationId: randomUUID(),
    hostClientId: "product-rig:web-a",
    timeoutMs: 5_000,
  });
  if (!committed || committed.phase !== "committed") throw new Error("workspace commit failed");
  timings.atomicPrepareCommitMs = Math.round((performance.now() - started) * 100) / 100;
}

function tmuxClientInventory(): TmuxClientInventoryEntry[] {
  const output = execFileSync(
    "tmux",
    [
      "-S",
      socketPath,
      "list-clients",
      "-F",
      "#{client_control_mode}\t#{client_pid}\t#{client_tty}\t#{session_name}",
    ],
    { encoding: "utf8" },
  );
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [controlMode, rawPid, tty, clientSession] = line.split("\t");
      return {
        controlMode: controlMode === "1",
        pid: Number(rawPid),
        tty: tty ?? "",
        session: clientSession ?? "",
      };
    });
}

function controlClientCount(): number {
  return tmuxClientInventory().filter(({ controlMode }) => controlMode).length;
}

function stopNativeClient(): void {
  const client = nativeClient;
  nativeClient = null;
  if (!client) return;
  try {
    client.kill("SIGTERM");
  } catch {
    // It may already have exited; inventory below is the source of truth.
  }
}

async function attachNativeClient(): Promise<TmuxClientInventoryEntry> {
  const failures: NativeClientDiagnostics[] = [];
  const helper = fileURLToPath(new URL("./product-test-rig-native-client.mjs", import.meta.url));
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const diagnostics: NativeClientDiagnostics = {
      attempt,
      exit: null,
      output: "",
      processPid: -1,
      ptyPid: null,
      tmuxClients: [],
    };
    try {
      // The integration helper itself runs under Bun. node-pty's native fork
      // lifecycle is not compatible with Bun, so a small Node host owns the
      // PTY while this process continues to assert daemon-visible tmux truth.
      const client = spawn("node", [helper, socketPath, session, "101", "31"], {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      nativeClient = client;
      diagnostics.processPid = client.pid ?? -1;
      client.stdout.on("data", (data: Buffer) => {
        const text = data.toString("utf8");
        diagnostics.output = `${diagnostics.output}${text}`.slice(-4_096);
        for (const line of text.split("\n")) {
          try {
            const message = JSON.parse(line) as { ptyPid?: unknown };
            if (typeof message.ptyPid === "number") diagnostics.ptyPid = message.ptyPid;
          } catch {
            // Partial lines remain in diagnostics and cannot grant proof.
          }
        }
      });
      client.stderr.on("data", (data: Buffer) => {
        diagnostics.output = `${diagnostics.output}${data.toString("utf8")}`.slice(-4_096);
      });
      client.on("error", (error) => {
        diagnostics.output = `${diagnostics.output}\n${String(error)}`.slice(-4_096);
      });
      client.on("exit", (exitCode, signal) => {
        diagnostics.exit = { exitCode, signal };
      });

      const deadline = performance.now() + 3_000;
      while (performance.now() < deadline) {
        diagnostics.tmuxClients = tmuxClientInventory();
        const attached = diagnostics.tmuxClients.find(
          ({ controlMode, pid, session: clientSession, tty }) =>
            !controlMode &&
            diagnostics.ptyPid !== null &&
            pid === diagnostics.ptyPid &&
            clientSession === session &&
            tty.startsWith("/dev/"),
        );
        if (attached) return attached;
        if (diagnostics.exit) break;
        await Bun.sleep(20);
      }
    } catch (error) {
      diagnostics.output = `${diagnostics.output}\n${String(error)}`.slice(-4_096);
    }
    failures.push({ ...diagnostics, tmuxClients: [...diagnostics.tmuxClients] });
    stopNativeClient();
    await Bun.sleep(50);
  }
  throw new Error(`Native tmux attach failed: ${JSON.stringify(failures)}`);
}

try {
  await proveGenerationFence();
  const webA = await connect("web-a");
  const webB = await connect("web-b");
  const opentui = await connect("opentui");
  if (new Set([...snapshots.values()].map(({ generation: value }) => value)).size !== 1) {
    throw new Error("clients did not converge on one daemon generation");
  }

  await echo("web-a", webA);
  await echo("web-b", webB);
  await echo("opentui", opentui);
  await proveAtomicPrepareCommit();

  webA.setPresence("foreground");
  const geometryA = await webA.requestAuthority("geometry");
  if (!geometryA) throw new Error("web-a did not acquire geometry");
  const geometryBWhileA = await webB.requestAuthority("geometry");
  if (geometryBWhileA !== null) throw new Error("sticky geometry oscillated to web-b");
  webA.setPresence("background");
  webB.setPresence("foreground");
  const geometryB = await webB.requestAuthority("geometry");
  if (!geometryB || geometryB.clientId !== "product-rig:web-b") {
    throw new Error("foreground geometry did not converge on web-b");
  }

  const nativeStartedAt = performance.now();
  geometryOwnersSeen.set("web-b", []);
  const nativeInventory = await attachNativeClient();
  await waitFor(
    "native tmux geometry yield",
    () => geometryOwnersSeen.get("web-b")?.includes(null) === true,
    5_000,
  );
  timings.nativeYieldMs = Math.round((performance.now() - nativeStartedAt) * 100) / 100;
  stopNativeClient();
  await waitFor(
    "native tmux client detach",
    () => !tmuxClientInventory().some(({ pid }) => pid === nativeInventory.pid),
    5_000,
  );
  // Native activity deliberately suppresses client geometry claims for a
  // bounded hysteresis window. Cross that fence before re-submitting the
  // already-established claim; transport/topology errors reject immediately.
  // Production's native geometry hysteresis is 180ms. Cross that fence once,
  // then issue exactly one claim so this proof cannot manufacture an
  // authority-revision storm by repeatedly re-claiming the same capability.
  await Bun.sleep(250);
  const geometryAfterNative = await webB.requestAuthority("geometry");
  if (!geometryAfterNative || geometryAfterNative.clientId !== "product-rig:web-b") {
    throw new Error("web-b did not reacquire geometry after the native quiet period");
  }
  timings.nativeQuietReacquireMs = Math.round((performance.now() - nativeStartedAt) * 100) / 100;
  const retainedControlClients = controlClientCount();
  if (retainedControlClients > 1) {
    throw new Error(`duplicate retained tmux control owners: ${retainedControlClients}`);
  }

  const final = webB.authoritySnapshot;
  process.stdout.write(
    `${JSON.stringify({
      status: "passed",
      generation,
      workspaceName,
      session,
      pane,
      nativeClient: nativeInventory,
      clientCount: 3,
      requirements: {
        authorityByteEcho: { passed: true, skipped: false },
        foregroundBackground: { passed: true, skipped: false },
        geometryStability: { passed: true, skipped: false },
        nativeGeometryYield: { passed: true, skipped: false },
        atomicPrepareCommit: { passed: true, skipped: false },
        daemonRestartRecovery: {
          passed: previousGeneration !== null && previousGeneration !== generation,
          skipped: false,
          previousGeneration,
        },
        uniqueTerminalOwner: {
          passed: true,
          skipped: false,
          retainedControlClients,
        },
      },
      finalAuthority: final,
      timings: { totalMs: elapsed(), ...timings },
    })}\n`,
  );
} finally {
  stopNativeClient();
  for (const client of clients.reverse()) client.close();
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredPaneInventory(name: string, activePane: string): string[] {
  const raw = required(name);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be an exact JSON pane inventory`);
  }
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 256 ||
    !value.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 256) ||
    new Set(value).size !== value.length ||
    !value.includes(activePane) ||
    JSON.stringify([...value].sort()) !== JSON.stringify(value)
  )
    throw new Error(`${name} must be the sorted, unique session pane inventory`);
  return value;
}
