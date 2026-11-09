/**
 * Plugin commands for the TUI palette: the plugin half of the daemon's
 * command catalog, plus invoking a command and asking for a parameter's
 * choices. Always the LOCAL canonical daemon, like the fleet preferences.
 *
 * The catalog is fetched when the palette opens, so a plugin reload shows up
 * the next time the palette is opened.
 */
import {
  CommandCatalogResourceSchemaZ,
  CommandInvokeResultSchemaZ,
  CommandParamOptionsResultSchemaZ,
  type CommandInvocationContext,
  type CommandInvokeResult,
  type CommandParamOptionsResult,
} from "@tmux-ide/contracts";
import { createSignal } from "solid-js";
import WebSocket from "ws";
import {
  canonicalDaemonUrl,
  readCanonicalDaemonInfo,
  type CanonicalDaemonInfo,
} from "../../../lib/canonical-daemon.ts";
import type { ApplicationPluginPaletteCommand } from "../workspace/application-command-description.ts";

/** The bits of a WebSocket the catalog watch uses. */
export interface CatalogEventSocket {
  addEventListener(type: "open" | "close" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface PluginCommandTransport {
  readonly daemon: () => CanonicalDaemonInfo | null;
  readonly fetch: typeof fetch;
  /** Opens the daemon's event socket; absent means no live updates. */
  readonly socket?: (url: string, ownerToken: string) => CatalogEventSocket;
}

const defaultTransport: PluginCommandTransport = {
  daemon: readCanonicalDaemonInfo,
  fetch: (...args) => fetch(...args),
  socket: (url, ownerToken) =>
    new WebSocket(url, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    }) as unknown as CatalogEventSocket,
};

async function request(
  transport: PluginCommandTransport,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const daemon = transport.daemon();
  if (!daemon?.authToken) throw new Error("No local tmux-ide daemon is running.");
  const response = await transport.fetch(
    canonicalDaemonUrl("http", daemon.bindHostname, daemon.port) + path,
    {
      method,
      redirect: "error",
      signal,
      headers: {
        Authorization: `Bearer ${daemon.authToken}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `The daemon answered ${response.status}.`;
    throw new Error(message);
  }
  return payload;
}

export function createApplicationPluginCommands(
  transport: PluginCommandTransport = defaultTransport,
) {
  const [commands, setCommands] = createSignal<readonly ApplicationPluginPaletteCommand[]>([]);
  let inflight: AbortController | null = null;
  const refresh = async (): Promise<void> => {
    inflight?.abort();
    const controller = new AbortController();
    inflight = controller;
    try {
      const parsed = CommandCatalogResourceSchemaZ.safeParse(
        await request(
          transport,
          "GET",
          "/api/resources/command-catalog",
          undefined,
          AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]),
        ),
      );
      if (!parsed.success || controller.signal.aborted) return;
      setCommands(
        parsed.data.entries.flatMap((entry) =>
          entry.plugin
            ? [
                {
                  kind: "plugin-command" as const,
                  id: entry.descriptor.id,
                  label: entry.descriptor.label,
                  category: entry.descriptor.category,
                  plugin: entry.plugin,
                  dangerous: entry.descriptor.dangerous,
                  params: entry.params,
                },
              ]
            : [],
        ),
      );
    } catch {
      // No daemon, or plugins off: the palette simply shows no plugin commands.
    } finally {
      if (inflight === controller) inflight = null;
    }
  };
  return {
    commands,
    /** Fetch the catalog again; keeps the last list if the daemon is unreachable. */
    refresh,
    /**
     * Follow the daemon's command-catalog invalidations while the palette is
     * open, so a plugin reload shows up without reopening it. Returns a stop
     * function; does nothing without a daemon or a socket.
     */
    watch(): () => void {
      const daemon = transport.daemon();
      if (!daemon?.authToken || !transport.socket) return () => {};
      let socket: CatalogEventSocket;
      try {
        socket = transport.socket(
          canonicalDaemonUrl("ws", daemon.bindHostname, daemon.port, "/ws/events?mode=semantic"),
          daemon.authToken,
        );
      } catch {
        return () => {};
      }
      let stopped = false;
      socket.addEventListener("error", () => {});
      socket.addEventListener("open", () => {
        socket.send(
          JSON.stringify({
            type: "subscribe",
            sessions: [],
            interests: [{ resource: "command-catalog", workspaceName: null }],
            legacyEvents: false,
          }),
        );
      });
      socket.addEventListener("message", (event) => {
        if (stopped || (typeof event.data !== "string" && !Buffer.isBuffer(event.data))) return;
        let frame: unknown;
        try {
          frame = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (
          frame &&
          typeof frame === "object" &&
          (frame as { type?: unknown }).type === "resource.changed" &&
          (frame as { resource?: unknown }).resource === "command-catalog"
        )
          void refresh();
      });
      return () => {
        if (stopped) return;
        stopped = true;
        socket.close(1000, "palette closed");
      };
    },
    async invoke(
      id: string,
      args: Record<string, string | number | boolean>,
      context: CommandInvocationContext,
      confirmed: boolean,
    ): Promise<CommandInvokeResult> {
      try {
        const parsed = CommandInvokeResultSchemaZ.safeParse(
          await request(
            transport,
            "POST",
            "/api/v2/commands/invoke",
            { id, args, context, ...(confirmed ? { confirmed: true } : {}) },
            AbortSignal.timeout(60_000),
          ),
        );
        return parsed.success
          ? parsed.data
          : { ok: false, error: "The daemon sent an unexpected answer." };
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
    },
    async paramOptions(
      id: string,
      param: string,
      context: CommandInvocationContext,
    ): Promise<CommandParamOptionsResult> {
      try {
        const parsed = CommandParamOptionsResultSchemaZ.safeParse(
          await request(
            transport,
            "POST",
            "/api/v2/commands/param-options",
            { id, param, context },
            AbortSignal.timeout(30_000),
          ),
        );
        return parsed.success
          ? parsed.data
          : { ok: false, error: "The daemon sent an unexpected answer." };
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
    },
  };
}

export type ApplicationPluginCommands = ReturnType<typeof createApplicationPluginCommands>;
