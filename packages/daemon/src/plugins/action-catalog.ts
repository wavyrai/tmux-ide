/**
 * The plugin half of the command catalog: the actions each loaded plugin
 * registered with `ide.action.register`, as catalog entries.
 *
 * A plugin's actions are replaced wholesale every time it publishes, and
 * dropped when it unloads, is disabled, loses consent or its host exits.
 */
import {
  COMMAND_PROTOCOL_VERSION,
  CommandCatalogEntrySchemaZ,
  CommandParamSchemaZ,
  plainTextSchema,
  type CommandCatalogEntry,
} from "@tmux-ide/contracts";
import { z } from "zod";
import { MAX_ACTIONS_PER_PLUGIN, MAX_LOCAL_ACTION_ID } from "./host/actions-prelude.ts";

/** What the host publishes for one action (plugin-local id). */
const PublishedActionSchemaZ = z
  .object({
    // "plugin." + a 63-character plugin name + "." + 80 = 151, under the
    // catalog's 160-character id limit.
    id: z
      .string()
      .regex(/^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*$/u)
      .max(MAX_LOCAL_ACTION_ID),
    title: plainTextSchema(1, 160),
    category: plainTextSchema(1, 80),
    description: plainTextSchema(1, 500).optional(),
    dangerous: z.boolean(),
    params: z.array(CommandParamSchemaZ).max(32),
  })
  .strict();
const PublishedActionsSchemaZ = z.array(PublishedActionSchemaZ).max(MAX_ACTIONS_PER_PLUGIN);

/** `plugin.<plugin>.<local id>`: the catalog id of a plugin action. */
export function pluginCommandId(plugin: string, action: string): string {
  return `plugin.${plugin}.${action}`;
}

/** Split a catalog id back into plugin and local action id, or null. */
export function parsePluginCommandId(id: string): { plugin: string; action: string } | null {
  const match = /^plugin\.([a-z][a-z0-9-]{0,62})\.(.+)$/u.exec(id);
  return match ? { plugin: match[1]!, action: match[2]! } : null;
}

export class PluginActionCatalog {
  readonly #byPlugin = new Map<string, CommandCatalogEntry[]>();
  readonly #onChange: () => void;
  #revision = 0;

  constructor(onChange: () => void = () => {}) {
    this.#onChange = onChange;
  }

  get revision(): number {
    return this.#revision;
  }

  /**
   * Replace `plugin`'s actions from the JSON text it published. Returns an
   * error message, without changing anything, if the list is malformed.
   */
  publish(plugin: string, json: string): string | null {
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch {
      return "published actions are not JSON";
    }
    // Lua's encoder writes an empty table as [] and omits nil fields, which
    // is exactly the shape the schema expects.
    const parsed = PublishedActionsSchemaZ.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return `published actions are invalid at ${issue?.path.join(".") ?? "?"}: ${issue?.message ?? ""}`;
    }
    const built = parsed.data.map((action) =>
      CommandCatalogEntrySchemaZ.safeParse({
        descriptor: {
          version: COMMAND_PROTOCOL_VERSION,
          id: pluginCommandId(plugin, action.id),
          owner: "plugin",
          label: action.title,
          ...(action.description ? { description: action.description } : {}),
          category: action.category,
          schemas: { input: `plugin:${plugin}` },
          dangerous: action.dangerous,
          confirmation: action.dangerous ? "dialog" : "none",
        },
        plugin,
        params: action.params,
      }),
    );
    // All or nothing: one bad entry refuses the whole list, and nothing in
    // plugin output can throw out of here into the daemon.
    const entries: CommandCatalogEntry[] = [];
    for (const result of built) {
      if (!result.success) {
        const issue = result.error.issues[0];
        return `published actions are invalid at ${issue?.path.join(".") ?? "?"}: ${issue?.message ?? ""}`;
      }
      entries.push(result.data);
    }
    const previous = this.#byPlugin.get(plugin) ?? [];
    if (entries.length === 0 && previous.length === 0) return null;
    if (JSON.stringify(previous) === JSON.stringify(entries)) return null;
    if (entries.length === 0) this.#byPlugin.delete(plugin);
    else this.#byPlugin.set(plugin, entries);
    this.#changed();
    return null;
  }

  /** Drop every action of `plugin`. */
  drop(plugin: string): void {
    if (!this.#byPlugin.delete(plugin)) return;
    this.#changed();
  }

  /** Drop everything, e.g. when the host exits; plugins publish again on load. */
  clear(): void {
    if (this.#byPlugin.size === 0) return;
    this.#byPlugin.clear();
    this.#changed();
  }

  entries(): CommandCatalogEntry[] {
    return [...this.#byPlugin.keys()].sort().flatMap((plugin) => this.#byPlugin.get(plugin) ?? []);
  }

  find(id: string): CommandCatalogEntry | undefined {
    const parsed = parsePluginCommandId(id);
    if (!parsed) return undefined;
    return this.#byPlugin.get(parsed.plugin)?.find((entry) => entry.descriptor.id === id);
  }

  #changed(): void {
    this.#revision += 1;
    this.#onChange();
  }
}
