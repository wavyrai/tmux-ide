import { WorkspaceCatalogResourceV3SchemaZ } from "../../packages/contracts/src/index.ts";
import { FleetClientStateResponseSchema } from "../../packages/contracts/src/fleet-client-state.ts";

const same = (a, b) =>
  ["instanceId", "startedAt", "productVersion", "protocolVersion"].every((k) => a?.[k] === b?.[k]);
/** Called only after failure against the gate's private daemon. No payload or credential is returned. */
export async function diagnosePackedEmpty(daemon, dependencies = {}) {
  const summary = {
    identityMatch: false,
    catalogValid: false,
    empty: null,
    preferencesRead: false,
    preferencesWrite: false,
  };
  if (
    !daemon ||
    !["127.0.0.1", "::1"].includes(daemon.bindHostname) ||
    !Number.isInteger(daemon.port) ||
    daemon.port < 1 ||
    daemon.port > 65535
  )
    return summary;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  const fetchImpl = dependencies.fetch ?? fetch;
  const base = `http://${daemon.bindHostname === "::1" ? "[::1]" : daemon.bindHostname}:${daemon.port}`;
  const request = async (path, body) => {
    const response = await fetchImpl(base + path, {
      method: body ? "POST" : "GET",
      redirect: "error",
      signal: controller.signal,
      headers:
        path === "/identity"
          ? {}
          : { Authorization: `Bearer ${daemon.authToken}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const reader = response.body?.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      if (reader)
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.length;
          if (bytes > 1048576) throw new Error("body-bound");
          chunks.push(Buffer.from(part.value));
        }
      return {
        ok: response.ok,
        status: response.status,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      };
    } finally {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
    }
  };
  try {
    const identity = await request("/identity");
    summary.identityMatch =
      identity.ok && same(daemon, identity.body) && daemon.pid === identity.body.pid;
    if (!summary.identityMatch) return summary;
    const catalog = await request("/api/resources/workspace-catalog?version=3");
    summary.catalogStatus = catalog.status;
    const parsed = WorkspaceCatalogResourceV3SchemaZ.safeParse(catalog.body);
    summary.catalogValid = catalog.ok && parsed.success && same(daemon, parsed.data.daemon);
    if (summary.catalogValid) summary.empty = parsed.data.liveSessions.length === 0;
    const preferences = await request("/api/resources/fleet-client-state");
    summary.preferencesReadStatus = preferences.status;
    const state = FleetClientStateResponseSchema.safeParse(preferences.body);
    summary.preferencesRead = preferences.ok && state.success && same(daemon, state.data.daemon);
    if (!summary.preferencesRead) return summary;
    // Preserve the observed favorite value: this exercises real private persistence without adding a preference.
    const key = "packed-diagnostic";
    const write = await request("/api/resources/fleet-client-state", {
      expectedInstanceId: daemon.instanceId,
      change: { type: "favorite", key, enabled: state.data.state.favorites.includes(key) },
    });
    summary.preferencesWriteStatus = write.status;
    const saved = FleetClientStateResponseSchema.safeParse(write.body);
    summary.preferencesWrite = write.ok && saved.success && same(daemon, saved.data.daemon);
  } catch {
    summary.failure = controller.signal.aborted ? "deadline" : "probe-failed";
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return summary;
}
