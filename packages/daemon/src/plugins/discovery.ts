/**
 * Find what to load: plugin directories under `<state home>/plugins/` in name
 * order, then the user's `<state home>/init.lua` last, so the user's file can
 * build on and override what plugins set up.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { consentState, hashPluginDirectory, readConsent } from "./consent.ts";
import {
  apiSatisfies,
  manifestDefaults,
  PluginManifestSchemaZ,
  type PluginManifest,
} from "./manifest.ts";
import {
  INIT_PLUGIN_NAME,
  PLUGIN_NAME_PATTERN,
  RESERVED_PLUGIN_NAMES,
  type PluginSpec,
} from "./protocol.ts";

export interface PluginProblem {
  readonly name: string;
  readonly path: string;
  readonly error: string;
}

/** A valid plugin that may not run yet: never consented, or changed since. */
export interface PluginAwaitingConsent {
  readonly name: string;
  readonly path: string;
  readonly reason: "new" | "changed";
  readonly hash: string;
  readonly manifest: PluginManifest;
}

export interface PluginDiscovery {
  readonly specs: readonly PluginSpec[];
  readonly problems: readonly PluginProblem[];
  readonly awaitingConsent: readonly PluginAwaitingConsent[];
}

export function pluginPaths(stateHome: string) {
  return {
    init: join(stateHome, "init.lua"),
    plugins: join(stateHome, "plugins"),
    lua: join(stateHome, "lua"),
    logs: join(stateHome, "logs"),
  };
}

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

const MAX_MANIFEST_BYTES = 64 * 1024;

export function discoverPlugins(stateHome: string): PluginDiscovery {
  const paths = pluginPaths(stateHome);
  const specs: PluginSpec[] = [];
  const problems: PluginProblem[] = [];
  const awaitingConsent: PluginAwaitingConsent[] = [];
  const consent = readConsent(stateHome);

  let entries: string[];
  try {
    entries = readdirSync(paths.plugins).sort();
  } catch {
    entries = [];
  }
  for (const dirName of entries) {
    if (dirName.startsWith(".")) continue;
    const dir = join(paths.plugins, dirName);
    const problem = (error: string) => problems.push({ name: dirName, path: dir, error });
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!PLUGIN_NAME_PATTERN.test(dirName)) {
      problem("directory name must be lowercase letters, digits and dashes");
      continue;
    }
    if (RESERVED_PLUGIN_NAMES.has(dirName)) {
      problem(`'${dirName}' is reserved for tmux-ide's own use; rename the directory`);
      continue;
    }
    const manifestPath = join(dir, "manifest.json");
    let raw: unknown;
    try {
      if (statSync(manifestPath).size > MAX_MANIFEST_BYTES) {
        problem("manifest.json is larger than 64 KiB");
        continue;
      }
      raw = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (error) {
      problem(
        existsSync(manifestPath)
          ? `manifest.json is not valid JSON: ${(error as Error).message}`
          : "manifest.json is missing",
      );
      continue;
    }
    const parsed = PluginManifestSchemaZ.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      problem(
        `manifest.json: ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid"}`,
      );
      continue;
    }
    const manifest = parsed.data;
    if (manifest.name !== dirName) {
      problem(`manifest name '${manifest.name}' does not match its directory '${dirName}'`);
      continue;
    }
    if (!apiSatisfies(manifest.api)) {
      problem(`needs Lua API ${manifest.api}, this tmux-ide provides a different version`);
      continue;
    }
    const entry = join(dir, manifest.entry);
    try {
      const realDir = realpathSync(dir);
      const realEntry = realpathSync(entry);
      if (!inside(realEntry, realDir)) {
        problem(`entry '${manifest.entry}' resolves outside the plugin directory`);
        continue;
      }
    } catch {
      problem(`entry '${manifest.entry}' is missing`);
      continue;
    }
    let hash: string;
    try {
      hash = hashPluginDirectory(dir);
    } catch (error) {
      problem(`could not read the plugin: ${(error as Error).message}`);
      continue;
    }
    const consented = consentState(consent, manifest.name, hash);
    if (consented !== "consented") {
      awaitingConsent.push({ name: manifest.name, path: dir, reason: consented, hash, manifest });
      continue;
    }
    specs.push({
      name: manifest.name,
      kind: "plugin",
      contentHash: hash,
      entry,
      // Only the plugin's own directory: consent hashes exactly what it can load.
      includeRoots: [dir],
      moduleRoots: [dir],
      settings: manifestDefaults(manifest),
      capabilities: {
        exec: [...(manifest.capabilities.exec ?? [])],
        shell: manifest.capabilities.shell === true,
      },
    });
  }

  if (existsSync(paths.init)) {
    specs.push({
      name: INIT_PLUGIN_NAME,
      kind: "init",
      entry: paths.init,
      includeRoots: [stateHome, paths.lua],
      moduleRoots: [paths.lua],
      settings: {},
      capabilities: { exec: "any", shell: true },
    });
  }
  return { specs, problems, awaitingConsent };
}
