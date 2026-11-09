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
import {
  canonicalDaemonUrl,
  readCanonicalDaemonInfo,
  type CanonicalDaemonInfo,
} from "../../../lib/canonical-daemon.ts";
import type { ApplicationPluginPaletteCommand } from "../workspace/application-command-description.ts";

export interface PluginCommandTransport {
  readonly daemon: () => CanonicalDaemonInfo | null;
  readonly fetch: typeof fetch;
}

const defaultTransport: PluginCommandTransport = {
  daemon: readCanonicalDaemonInfo,
  fetch: (...args) => fetch(...args),
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
  return {
    commands,
    /** Fetch the catalog again; keeps the last list if the daemon is unreachable. */
    async refresh(): Promise<void> {
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
