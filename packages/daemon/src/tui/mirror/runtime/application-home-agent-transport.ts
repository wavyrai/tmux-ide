import {
  ApplicationShellResourceV2SchemaZ,
  DaemonEventClientFrameSchemaZ,
  DaemonEventServerFrameSchemaZ,
  WorkspaceCatalogResourceV3SchemaZ,
  type CanonicalDaemonInfo,
  type DaemonInstanceIdentity,
} from "@tmux-ide/contracts";
import WebSocket from "ws";

import { canonicalDaemonUrl, readCanonicalDaemonInfo } from "../../../lib/canonical-daemon.ts";
import type { ApplicationHomeAgentDependencies } from "./application-home-agent-observer.ts";

export function sameHomeAgentDaemon(
  expected: DaemonInstanceIdentity,
  actual: DaemonInstanceIdentity,
): boolean {
  return (
    expected.instanceId === actual.instanceId &&
    expected.startedAt === actual.startedAt &&
    expected.productVersion === actual.productVersion &&
    expected.protocolVersion === actual.protocolVersion
  );
}

export interface HomeAgentEventSocket {
  on(event: "message", listener: (data: { toString(): string; length?: number }) => void): unknown;
  on(event: "error" | "close", listener: () => void): unknown;
  send(data: string): void;
  close(): void;
}

export function createApplicationHomeAgentTransport(
  options: {
    fetch?: typeof globalThis.fetch;
    createSocket?: (url: string, daemon: CanonicalDaemonInfo) => HomeAgentEventSocket;
    readDaemon?: () => CanonicalDaemonInfo | null;
  } = {},
): ApplicationHomeAgentDependencies {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const createSocket =
    options.createSocket ??
    ((url, daemon) =>
      new WebSocket(url, {
        headers: daemon.authToken ? { Authorization: `Bearer ${daemon.authToken}` } : undefined,
      }) as HomeAgentEventSocket);
  const urlFor = (daemon: CanonicalDaemonInfo, path: string, protocol: "http" | "ws" = "http") =>
    canonicalDaemonUrl(protocol, daemon.bindHostname, daemon.port, path);
  return {
    readDaemon: options.readDaemon ?? readCanonicalDaemonInfo,
    async fetchShell(daemon, session, signal) {
      const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
      const get = async (path: string) => {
        const response = await fetchImpl(urlFor(daemon, path), {
          method: "GET",
          headers: {
            accept: "application/json",
            ...(daemon.authToken ? { Authorization: `Bearer ${daemon.authToken}` } : {}),
          },
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
          signal: boundedSignal,
        });
        if (!response.ok) throw new Error(`Agent observation returned HTTP ${response.status}.`);
        return response.json();
      };
      const shell = ApplicationShellResourceV2SchemaZ.parse(
        await get(`/api/project/${encodeURIComponent(session.name)}/application-shell?version=2`),
      );
      if (!sameHomeAgentDaemon(daemon, shell.daemon)) throw new Error("Agent daemon changed.");
      // A name may have been deleted and reused while the shell read was in
      // flight. Validate its incarnation AFTER that read, before publication.
      const catalog = WorkspaceCatalogResourceV3SchemaZ.parse(
        await get("/api/resources/workspace-catalog?version=3"),
      );
      if (
        !sameHomeAgentDaemon(daemon, catalog.daemon) ||
        !catalog.liveSessions.some(
          (live) =>
            live.sessionName === session.name &&
            `${daemon.instanceId}:${live.liveSessionId}` === session.id,
        )
      )
        throw new Error("Agent session incarnation changed.");
      return shell;
    },
    connect(daemon, sessions, handlers) {
      let closed = false;
      let failed = false;
      const sockets: HomeAgentEventSocket[] = [];
      const deadlines = new Set<ReturnType<typeof setTimeout>>();
      const unavailable = new Set<string>();
      // The wire caps one interest frame at128. Usually one socket; explicit
      // Load more can add another bounded batch without a terminal connection.
      const batches = Array.from({ length: Math.ceil(sessions.length / 126) }, (_, index) =>
        sessions.slice(index * 126, (index + 1) * 126),
      );
      let pending = batches.length;
      const close = () => {
        if (closed) return;
        closed = true;
        for (const deadline of deadlines) clearTimeout(deadline);
        deadlines.clear();
        for (const socket of sockets) socket.close();
      };
      const fail = () => {
        if (closed || failed) return;
        failed = true;
        handlers.unavailable();
        close();
      };
      for (const batch of batches) {
        let socket: HomeAgentEventSocket;
        try {
          socket = createSocket(urlFor(daemon, "/ws/events?mode=semantic", "ws"), daemon);
        } catch {
          fail();
          break;
        }
        sockets.push(socket);
        const deadline = setTimeout(fail, 10_000);
        deadline.unref?.();
        deadlines.add(deadline);
        let verified = false;
        let acknowledged = false;
        let cursor = 0;
        socket.on("error", fail);
        socket.on("close", fail);
        socket.on("message", (data) => {
          if (closed || failed) return;
          const text = data.toString();
          if (text.length > 1_048_576) {
            fail();
            return;
          }
          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch {
            fail();
            return;
          }
          const parsed = DaemonEventServerFrameSchemaZ.safeParse(body);
          if (!parsed.success) {
            fail();
            return;
          }
          const frame = parsed.data;
          if (frame.type === "hello") {
            if (verified || !sameHomeAgentDaemon(daemon, frame.daemon)) {
              fail();
              return;
            }
            verified = true;
            cursor = frame.eventSequence ?? 0;
            try {
              socket.send(
                JSON.stringify(
                  DaemonEventClientFrameSchemaZ.parse({
                    type: "subscribe",
                    sessions: batch.map((session) => session.name),
                    interests: [
                      { resource: "workspace-catalog", workspaceName: null },
                      { resource: "fleet-catalog", workspaceName: null },
                      ...batch
                        .filter((session) => session.workspaceName)
                        .map((session) => ({
                          resource: "application-shell",
                          workspaceName: session.workspaceName,
                        })),
                    ],
                    legacyEvents: false,
                    interestRevision: 1,
                    afterSequence: cursor,
                  }),
                ),
              );
            } catch {
              fail();
            }
            return;
          }
          if (!verified) {
            fail();
            return;
          }
          if (frame.type === "resource.interests-ack") {
            if (frame.interestRevision !== 1 || acknowledged) return;
            acknowledged = true;
            clearTimeout(deadline);
            deadlines.delete(deadline);
            for (const interest of frame.unavailableInterests) {
              for (const session of batch) {
                if (
                  interest.workspaceName === null ||
                  interest.workspaceName === session.workspaceName
                )
                  unavailable.add(session.id);
              }
            }
            cursor = Math.max(cursor, frame.sequence);
            if (--pending === 0) handlers.ready([...unavailable]);
          } else if (frame.type === "snapshot-required") {
            cursor = frame.currentSequence;
            for (const session of batch) handlers.invalidate(session.id);
          } else if (frame.type === "resource.changed" || frame.type === "resource.observed") {
            if (frame.sequence <= cursor) return;
            if (frame.sequence > cursor + 1)
              for (const session of batch) handlers.invalidate(session.id);
            cursor = frame.sequence;
            if (frame.type === "resource.changed") {
              for (const session of batch) {
                if (
                  frame.resource === "workspace-catalog" ||
                  frame.resource === "fleet-catalog" ||
                  (frame.resource === "application-shell" &&
                    frame.workspaceName === session.workspaceName)
                )
                  handlers.invalidate(session.id);
              }
            }
          } else if (frame.type === "protocol.error") fail();
        });
      }
      return { close };
    },
  };
}

export const applicationHomeAgentTransport = createApplicationHomeAgentTransport();
