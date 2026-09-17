import WebSocket from "ws";
import {
  ApplicationShellResourceV2SchemaZ,
  WorkspaceCatalogResourceV3SchemaZ,
  DaemonEventServerFrameSchemaZ,
} from "../../packages/contracts/src/index.ts";

const same = (left, right) =>
  ["instanceId", "startedAt", "productVersion", "protocolVersion"].every(
    (key) => left?.[key] === right?.[key],
  );
const fields = new Set([
  "version",
  "daemon",
  "resource",
  "workspace",
  "sidebar",
  "agents",
  "terminalInventory",
  "resources",
  "intents",
  "liveSessions",
  "liveSessionId",
  "sessionName",
  "workspaceName",
  "paneCount",
  "id",
  "activity",
  "attention",
  "kind",
  "name",
  "paneId",
  "protocolVersion",
  "productVersion",
  "instanceId",
  "startedAt",
]);
function schemaSummary(parsed) {
  return parsed.success
    ? { valid: true }
    : {
        valid: false,
        issues: parsed.error.issues.slice(0, 8).map((issue) => ({
          code: issue.code,
          path: issue.path
            .slice(0, 8)
            .map((key) => (typeof key === "number" ? key : fields.has(key) ? key : "<field>")),
        })),
      };
}
/** Read-only diagnostics for the installed Home gate. Never returns resource bodies or credentials. */
export async function diagnosePackedHome(daemon, sessionName, dependencies = {}) {
  const fetchImpl = dependencies.fetch ?? fetch;
  const createSocket =
    dependencies.createSocket ?? ((url, headers) => new WebSocket(url, { headers }));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7500);
  let socket, socketClosed;
  const summary = { identityMatch: false, socketClosed: true };
  const headers = {
    accept: "application/json",
    ...(daemon.authToken ? { Authorization: `Bearer ${daemon.authToken}` } : {}),
  };
  const base = `http://${daemon.bindHostname.includes(":") ? `[${daemon.bindHostname}]` : daemon.bindHostname}:${daemon.port}`;
  const get = async (path, authorized = true) => {
    const response = await fetchImpl(base + path, {
      headers: authorized ? headers : {},
      signal: controller.signal,
      cache: "no-store",
      redirect: "error",
      credentials: "omit",
    });
    const reader = response.body?.getReader();
    const chunks = [];
    let length = 0;
    if (reader)
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > 1048576) throw new Error("body-bound");
          chunks.push(Buffer.from(value));
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    return {
      status: response.status,
      ok: response.ok,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
  };
  try {
    const identity = await get("/identity", false);
    summary.identityMatch =
      identity.ok && same(daemon, identity.body) && daemon.pid === identity.body.pid;
    if (!summary.identityMatch) return summary;
    const before = await get("/api/resources/workspace-catalog?version=3");
    const parsedCatalog = WorkspaceCatalogResourceV3SchemaZ.safeParse(before.body);
    summary.catalog = { status: before.status, ...schemaSummary(parsedCatalog) };
    if (!before.ok || !parsedCatalog.success) return summary;
    const catalog = parsedCatalog.data;
    const matches = catalog.intents.filter((entry) => entry.sessionName === sessionName);
    const live = catalog.liveSessions.filter((entry) => entry.sessionName === sessionName);
    Object.assign(summary.catalog, {
      daemonMatch: same(daemon, catalog.daemon),
      matchingIntents: matches.length,
      matchingLiveSessions: live.length,
    });
    const interests = [
      { resource: "workspace-catalog", workspaceName: null },
      { resource: "fleet-catalog", workspaceName: null },
      ...(matches[0]
        ? [{ resource: "application-shell", workspaceName: matches[0].workspaceName }]
        : []),
    ];
    const ack = new Promise((resolveAck) => {
      let settled = false;
      let verified = false;
      const done = (value) => {
        if (!settled) {
          settled = true;
          controller.signal.removeEventListener("abort", abort);
          resolveAck(value);
        }
      };
      const abort = () => done({ outcome: "timeout" });
      controller.signal.addEventListener("abort", abort, { once: true });
      socket = createSocket(base.replace(/^http/, "ws") + "/ws/events?mode=semantic", headers);
      summary.socketClosed = false;
      socketClosed = new Promise((resolveClose) =>
        socket.once("close", () => {
          summary.socketClosed = true;
          resolveClose();
        }),
      );
      socket.on("error", () => done({ outcome: "error" }));
      socket.on("close", () => done({ outcome: "closed" }));
      socket.on("message", (bytes) => {
        if (settled) return;
        const text = bytes.toString();
        if (text.length > 1048576) return done({ outcome: "frame-bound" });
        let parsed;
        try {
          parsed = DaemonEventServerFrameSchemaZ.safeParse(JSON.parse(text));
        } catch {
          return done({ outcome: "invalid-frame" });
        }
        if (!parsed.success) return done({ outcome: "invalid-frame" });
        const frame = parsed.data;
        if (frame.type === "hello") {
          if (!same(daemon, frame.daemon)) return done({ outcome: "identity-mismatch" });
          verified = true;
          try {
            socket.send(
              JSON.stringify({
                type: "subscribe",
                sessions: [sessionName],
                interests,
                legacyEvents: false,
                interestRevision: 1,
                afterSequence: frame.eventSequence ?? 0,
              }),
            );
          } catch {
            done({ outcome: "send-error" });
          }
        } else if (frame.type === "resource.interests-ack") {
          if (!verified) return done({ outcome: "unverified-ack" });
          done({
            outcome: "ack",
            unavailableResources: frame.unavailableInterests
              .map((entry) => entry.resource)
              .slice(0, 8),
          });
        } else if (frame.type === "protocol.error") done({ outcome: "protocol-error" });
      });
    }).catch(() => ({ outcome: "error" }));
    const shell = await get(
      `/api/project/${encodeURIComponent(sessionName)}/application-shell?version=2`,
    );
    const parsedShell = ApplicationShellResourceV2SchemaZ.safeParse(shell.body);
    summary.shell = { status: shell.status, ...schemaSummary(parsedShell) };
    if (parsedShell.success)
      Object.assign(summary.shell, {
        daemonMatch: same(daemon, parsedShell.data.daemon),
        agents: parsedShell.data.resource.workspace.sidebar.agents.length,
      });
    const after = await get("/api/resources/workspace-catalog?version=3");
    const parsedAfter = WorkspaceCatalogResourceV3SchemaZ.safeParse(after.body);
    summary.catalogAfter = { status: after.status, ...schemaSummary(parsedAfter) };
    if (parsedAfter.success)
      Object.assign(summary.catalogAfter, {
        daemonMatch: same(daemon, parsedAfter.data.daemon),
        sameIncarnation:
          live.length === 1 &&
          parsedAfter.data.liveSessions.some(
            (entry) =>
              entry.sessionName === sessionName && entry.liveSessionId === live[0].liveSessionId,
          ),
      });
    summary.events = await ack;
  } catch {
    summary.failure = controller.signal.aborted ? "timeout" : "read-refused";
  } finally {
    controller.abort();
    clearTimeout(timeout);
    if (socket) {
      socket.terminate();
      let closeTimer;
      await Promise.race([
        socketClosed,
        new Promise((resolveClose) => {
          closeTimer = setTimeout(resolveClose, 500);
        }),
      ]);
      clearTimeout(closeTimer);
    }
  }
  return summary;
}
