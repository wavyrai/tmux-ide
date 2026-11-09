/**
 * What a plugin's host functions do on the daemon side. The Lua side calls
 * `_exec`, `_panes` and the rest (see host/host-api-prelude.ts); the host
 * forwards each call here, and this answers with plain JSON.
 *
 * Pane, window and session calls go through the daemon's own HTTP surface
 * with the owner credential: the action dispatcher for workspace actions and
 * the automation API for reading and typing into panes. Plugins therefore
 * pass exactly the gates a CLI or the app would.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  AutomationExecuteResponseSchemaZ,
  AutomationPaneEndpointSchemaZ,
  AutomationPanesResponseSchemaZ,
  AutomationReserveResponseSchemaZ,
  type AutomationOperationIntent,
} from "@tmux-ide/contracts";
import { z } from "zod";
import { PluginPrograms, runPluginExec, type ExecPolicy, type PaneContext } from "./plugin-exec.ts";
import { PluginStore, pluginStorePath } from "./plugin-store.ts";
import { INIT_PLUGIN_NAME, RUN_STATE_NAME } from "./protocol.ts";

/** Workspace actions a plugin may dispatch (all multiplexer verbs on panes, windows and sessions). */
export const PLUGIN_WORKSPACE_ACTIONS: ReadonlySet<string> = new Set([
  "workspace.window.split",
  "workspace.window.kill",
  "workspace.pane.kill",
  "workspace.session.kill",
  "workspace.rename",
  "workspace.pane.zoom.toggle",
  "workspace.pane.select",
  "workspace.pane.swap",
  "workspace.pane.resize",
]);

export const NOTIFY_MAX_CHARS = 200;

export interface DaemonEndpoint {
  readonly baseUrl: string;
  readonly ownerToken: string;
}

export interface HostCallDependencies {
  readonly stateHome: string;
  /** The daemon's own HTTP endpoint; null before it is listening. */
  readonly endpoint: () => DaemonEndpoint | null;
  readonly fetch?: typeof fetch;
  /** Run tmux against the daemon's server and return stdout. */
  readonly tmux: (args: readonly string[]) => Promise<string>;
  readonly baseEnv: () => NodeJS.ProcessEnv;
  readonly secrets: () => ReadonlySet<string>;
  /** Show a short message to the people using tmux-ide. */
  readonly notify: (plugin: string, text: string, level: NotifyLevel) => Promise<void>;
  /** Tests replace the program runner. */
  readonly exec?: typeof runPluginExec;
  /** Files programs may not read: the daemon record and credential files. */
  readonly unreadable?: () => readonly string[];
  /** The longest a program may run: the callback wall clock. */
  readonly execMaxTimeoutMs?: number;
}

export type NotifyLevel = "info" | "warn" | "error";

export interface HostCallCaller {
  readonly plugin: string;
  /** The invoke or param-options request whose callback made this call. */
  readonly origin?: string;
  readonly capabilities: {
    readonly exec: readonly string[] | "any";
    readonly shell: boolean;
    /** Type into panes and run programs as if typed there (`panes.send`). */
    readonly panes: boolean;
  };
}

export class HostCallError extends Error {}

function fail(message: string): never {
  throw new HostCallError(message);
}

const EndpointArgZ = AutomationPaneEndpointSchemaZ;
const PaneReadArgsZ = z.tuple([EndpointArgZ]);
const PaneSendArgsZ = z.tuple([
  EndpointArgZ,
  z
    .string()
    .min(1)
    .max(16 * 1024),
  z.boolean(),
]);
const ActionArgsZ = z.tuple([z.string(), z.record(z.string(), z.json())]);
const NotifyArgsZ = z.tuple([
  z.string().min(1).max(10_000),
  z.enum(["info", "warn", "error"]).optional(),
]);
const StoreKeyZ = z.string().min(1).max(200);
const ActionEnvelopeZ = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: z.unknown().optional() }),
  z.object({ ok: z.literal(false), error: z.object({ message: z.string() }) }),
]);

/** Parse `#{socket_path}\t#{pid}\t#{session_id}\t#{pane_current_path}`. */
export function paneContextFromTmux(pane: string, line: string): PaneContext | null {
  const [socket, pid, session, cwd] = line.replace(/\n$/u, "").split("\t");
  const index = /^\$(\d+)$/u.exec(session ?? "")?.[1];
  if (!socket || !pid || !/^\d+$/u.test(pid) || index === undefined || !cwd) return null;
  return { tmux: `${socket},${pid},${index}`, pane, cwd };
}

export function createHostCallHandler(deps: HostCallDependencies) {
  const programs = new PluginPrograms();
  const request = async (path: string, init: RequestInit): Promise<unknown> => {
    const endpoint = deps.endpoint();
    if (!endpoint) fail("E_UNAVAILABLE: the daemon is not ready yet");
    const response = await (deps.fetch ?? fetch)(`${endpoint.baseUrl}${path}`, {
      ...init,
      redirect: "error",
      headers: {
        Authorization: `Bearer ${endpoint.ownerToken}`,
        "Content-Type": "application/json",
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = body && typeof body === "object" && "error" in body ? body.error : null;
      const message =
        typeof error === "string"
          ? error
          : error && typeof error === "object" && "message" in error
            ? String((error as { message: unknown }).message)
            : error && typeof error === "object" && "code" in error
              ? String((error as { code: unknown }).code)
              : `HTTP ${response.status}`;
      fail(`E_FAILED: ${message}`);
    }
    return body;
  };

  const automation = async (intent: AutomationOperationIntent) => {
    const reserved = AutomationReserveResponseSchemaZ.parse(
      await request("/api/v1/automation/reserve", {
        method: "POST",
        body: JSON.stringify({ version: 1, intent, origin: "sdk" }),
      }),
    );
    return AutomationExecuteResponseSchemaZ.parse(
      await request("/api/v1/automation/execute", {
        method: "POST",
        body: JSON.stringify({ version: 1, intent, origin: "sdk", handle: reserved.handle }),
      }),
    );
  };

  const resolvePane = async (pane: string): Promise<PaneContext | null> => {
    try {
      const line = await deps.tmux([
        "display-message",
        "-p",
        "-t",
        pane,
        "#{socket_path}\t#{pid}\t#{session_id}\t#{pane_current_path}",
      ]);
      return paneContextFromTmux(pane, line);
    } catch {
      return null;
    }
  };

  const store = (plugin: string) => {
    if (plugin === RUN_STATE_NAME) fail("E_UNAVAILABLE: `lua run` has no store");
    return new PluginStore(pluginStorePath(deps.stateHome, plugin));
  };

  const methods: Record<string, (caller: HostCallCaller, args: unknown[]) => Promise<unknown>> = {
    async _exec(caller, args) {
      const policy: ExecPolicy = {
        programs: caller.capabilities.exec,
        shell: caller.capabilities.shell,
        panes: caller.capabilities.panes,
      };
      return (deps.exec ?? runPluginExec)(args[0], {
        policy,
        sandbox: {
          stateHome: deps.stateHome,
          writable: join(deps.stateHome, "plugin-data", caller.plugin),
          unreadable: deps.unreadable?.() ?? [],
        },
        baseEnv: deps.baseEnv(),
        resolvePane,
        secrets: deps.secrets,
        ...(deps.execMaxTimeoutMs === undefined ? {} : { maxTimeoutMs: deps.execMaxTimeoutMs }),
        track: (child) => programs.track(caller.plugin, child, caller.origin),
      });
    },
    async _panes() {
      const panes = AutomationPanesResponseSchemaZ.parse(
        await request("/api/v1/automation/panes", { method: "GET" }),
      );
      return panes.panes.map((pane) => ({
        endpoint: pane.endpoint,
        title: pane.title,
        session: pane.sessionName,
      }));
    },
    async _pane_read(_caller, args) {
      const [target] = PaneReadArgsZ.parse(args);
      const result = await automation({ kind: "read", target, source: null });
      return result.read?.availability === "available" ? result.read.text : null;
    },
    async _pane_send(caller, args) {
      if (!caller.capabilities.panes)
        fail("E_DENIED: typing into a pane needs the manifest capability 'panes.send'");
      const [target, text, enter] = PaneSendArgsZ.parse(args);
      await automation({ kind: "send", target, source: null, text, enter });
      return true;
    },
    async _action(_caller, args) {
      const [name, input] = ActionArgsZ.parse(args);
      if (!PLUGIN_WORKSPACE_ACTIONS.has(name)) fail(`E_DENIED: plugins may not run '${name}'`);
      const body = await request(`/api/v2/action/${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "X-Tmux-Ide-Operation-Id": randomUUID() },
        body: JSON.stringify(input),
      });
      // The dispatcher answers 200 with an { ok: false, error } envelope for
      // refusals it reaches after the gate.
      const envelope = ActionEnvelopeZ.safeParse(body);
      if (!envelope.success) fail("E_FAILED: the daemon sent an unexpected answer");
      if (!envelope.data.ok) fail(`E_FAILED: ${envelope.data.error.message}`);
      return envelope.data.result ?? null;
    },
    async _notify(caller, args) {
      const [text, level = "info"] = NotifyArgsZ.parse(args);
      const clipped = text.replace(/\s+/gu, " ").trim().slice(0, NOTIFY_MAX_CHARS);
      if (!clipped) return false;
      await deps.notify(caller.plugin, clipped, level);
      return true;
    },
    async _store_get(caller, args) {
      return store(caller.plugin).get(StoreKeyZ.parse(args[0]));
    },
    async _store_set(caller, args) {
      store(caller.plugin).set(StoreKeyZ.parse(args[0]), args[1]);
      return true;
    },
    async _store_keys(caller) {
      return store(caller.plugin).keys();
    },
  };

  return {
    methods: Object.keys(methods),
    /**
     * Kill the programs `plugin` started (or every plugin's) that still run;
     * with `origin`, only those started for that request.
     */
    stopPrograms(plugin?: string, origin?: string): number {
      return programs.kill(plugin, origin);
    },
    runningPrograms(plugin: string): number {
      return programs.running(plugin);
    },
    async handle(caller: HostCallCaller, method: string, args: unknown[]): Promise<unknown> {
      const fn = Object.hasOwn(methods, method) ? methods[method] : undefined;
      if (!fn) fail(`E_INVALID: no host function '${method}'`);
      try {
        return await fn(caller, args);
      } catch (error) {
        if (error instanceof HostCallError) throw error;
        if (error instanceof z.ZodError) fail(`E_INVALID: bad arguments to ${method.slice(1)}`);
        throw new HostCallError((error as Error).message);
      }
    },
  };
}

export type HostCallHandler = ReturnType<typeof createHostCallHandler>;

/** What init.lua and `lua run` may do: everything a plugin could be granted. */
export function ownerCapabilities(plugin: string): HostCallCaller["capabilities"] | null {
  return plugin === INIT_PLUGIN_NAME || plugin === RUN_STATE_NAME
    ? { exec: "any", shell: true, panes: true }
    : null;
}
