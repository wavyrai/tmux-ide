/**
 * `manifest.json` in each plugin directory. JSON, so the daemon and the
 * installer can read what a plugin asks for without running any Lua.
 */
import { z } from "zod";
import { PLUGIN_API_VERSION, PluginNameSchemaZ } from "./protocol.ts";

const SettingSchemaZ = z
  .object({
    type: z.enum(["string", "integer", "number", "boolean"]),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    description: z.string().max(500).optional(),
    optional: z.boolean().optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
  })
  .strict();

export const PluginManifestSchemaZ = z
  .object({
    name: PluginNameSchemaZ,
    version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u, "version must be semver"),
    description: z.string().max(500).optional(),
    /** The Lua API versions this plugin works with: `^1.0` or `1.0`. */
    api: z.string().regex(/^\^?\d+\.\d+$/u, "api must look like ^1.0"),
    entry: z
      .string()
      .regex(/^[\w-]+(?:\/[\w-]+)*\.lua$/u, "entry must be a relative .lua path")
      .default("init.lua"),
    capabilities: z
      .object({
        exec: z
          .array(z.string().regex(/^[\w.+-]{1,64}$/u))
          .max(32)
          .optional(),
        sidebar: z.boolean().optional(),
        status: z.boolean().optional(),
        keys: z.boolean().optional(),
      })
      .strict()
      .default({}),
    settings: z.record(z.string().regex(/^[a-z_][a-z0-9_]{0,63}$/u), SettingSchemaZ).default({}),
  })
  .strict();
export type PluginManifest = z.infer<typeof PluginManifestSchemaZ>;

/**
 * Whether this host's API version satisfies a manifest's `api` range.
 * `^X.Y` and `X.Y` both mean: major X, minor at least Y.
 */
export function apiSatisfies(range: string, hostVersion: string = PLUGIN_API_VERSION): boolean {
  const wanted = /^\^?(\d+)\.(\d+)$/u.exec(range);
  const have = /^(\d+)\.(\d+)$/u.exec(hostVersion);
  if (!wanted || !have) return false;
  return Number(wanted[1]) === Number(have[1]) && Number(have[2]) >= Number(wanted[2]);
}

/** Default setting values declared by a manifest. */
export function manifestDefaults(
  manifest: PluginManifest,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, setting] of Object.entries(manifest.settings)) {
    if (setting.default !== undefined) out[key] = setting.default;
  }
  return out;
}
