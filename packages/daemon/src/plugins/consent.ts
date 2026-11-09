/**
 * Consent for installed plugins.
 *
 * A plugin directory under `plugins/` runs only after its owner consented to
 * that exact content: consent records a SHA-256 over every file in the plugin
 * directory, and any change to any file (manifest included) means the plugin
 * asks again. `init.lua` is the user's own file and needs no consent.
 *
 * Consent lives in `<state home>/plugins-consent.json` (mode 0600).
 */
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

export const CONSENT_FILE = "plugins-consent.json";
/** Plugins larger than this are refused rather than hashed. */
export const MAX_PLUGIN_FILES = 2000;
export const MAX_PLUGIN_BYTES = 32 * 1024 * 1024;

const ConsentFileSchemaZ = z
  .object({
    version: z.literal(1),
    plugins: z.record(
      z.string(),
      z.object({ hash: z.string().regex(/^sha256:[0-9a-f]{64}$/u), at: z.string() }).strict(),
    ),
  })
  .strict();
export type ConsentFile = z.infer<typeof ConsentFileSchemaZ>;

export function consentPath(stateHome: string): string {
  return join(stateHome, CONSENT_FILE);
}

/**
 * Hash every file under `dir`: relative path, type and content, in sorted
 * order. Symlinks are hashed by their target text and never followed.
 */
export function hashPluginDirectory(dir: string): string {
  const hash = createHash("sha256");
  let files = 0;
  let bytes = 0;
  const walk = (relative: string) => {
    const absolute = join(dir, relative);
    for (const name of readdirSync(absolute).sort()) {
      const childRelative = relative ? `${relative}/${name}` : name;
      const child = join(dir, childRelative);
      const stat = lstatSync(child);
      files += 1;
      if (files > MAX_PLUGIN_FILES)
        throw new Error(`plugin has more than ${MAX_PLUGIN_FILES} files`);
      if (stat.isSymbolicLink()) {
        hash.update(`L\0${childRelative}\0${readlinkSync(child)}\0`);
      } else if (stat.isDirectory()) {
        hash.update(`D\0${childRelative}\0`);
        walk(childRelative);
      } else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > MAX_PLUGIN_BYTES) throw new Error("plugin is larger than 32 MiB");
        const content = readFileSync(child);
        hash.update(`F\0${childRelative}\0${content.byteLength}\0`);
        hash.update(content);
      }
    }
  };
  walk("");
  return `sha256:${hash.digest("hex")}`;
}

export function readConsent(stateHome: string): ConsentFile {
  try {
    const parsed = ConsentFileSchemaZ.safeParse(
      JSON.parse(readFileSync(consentPath(stateHome), "utf8")),
    );
    if (parsed.success) return parsed.data;
  } catch {
    // Missing or unreadable: nothing is consented.
  }
  return { version: 1, plugins: {} };
}

export type ConsentState = "consented" | "new" | "changed";

export function consentState(consent: ConsentFile, name: string, hash: string): ConsentState {
  const recorded = consent.plugins[name];
  if (!recorded) return "new";
  return recorded.hash === hash ? "consented" : "changed";
}

function writeConsent(stateHome: string, consent: ConsentFile): void {
  const path = consentPath(stateHome);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(consent, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/** Record consent for `name` at exactly `hash`. */
export function grantConsent(stateHome: string, name: string, hash: string, at = new Date()): void {
  const consent = readConsent(stateHome);
  consent.plugins[name] = { hash, at: at.toISOString() };
  writeConsent(stateHome, consent);
}

export function revokeConsent(stateHome: string, name: string): boolean {
  const consent = readConsent(stateHome);
  if (!consent.plugins[name]) return false;
  delete consent.plugins[name];
  writeConsent(stateHome, consent);
  return true;
}
