/**
 * `ide.store`: a small JSON key/value store per plugin, kept in
 * `<state>/plugin-store/<plugin>.json`. That is outside the plugin's data
 * directory on purpose: programs a plugin runs can write there, and the
 * daemon must never read or write through anything they planted.
 *
 * Reads refuse symlinks, non-regular files and files over the cap; writes
 * go to a fresh randomly named file and are renamed into place.
 */
import { join } from "node:path";
import { toPlainJson } from "./host/lua-state.ts";
import { readRegularFile, UnsafeFileError, writeFileAtomic } from "./safe-files.ts";

export const STORE_MAX_BYTES = 1024 * 1024;
export const STORE_MAX_KEYS = 1000;

export class PluginStoreError extends Error {}

/** Where `plugin`'s store lives. */
export function pluginStorePath(stateHome: string, plugin: string): string {
  return join(stateHome, "plugin-store", `${plugin}.json`);
}

export class PluginStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  #read(): Record<string, unknown> {
    let text: string | null;
    try {
      text = readRegularFile(this.#path, STORE_MAX_BYTES);
    } catch (error) {
      if (error instanceof UnsafeFileError)
        throw new PluginStoreError(`E_FAILED: the store file is unusable (${error.message})`);
      throw error;
    }
    if (text === null) return {};
    try {
      const parsed: unknown = JSON.parse(text);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  get(key: string): unknown {
    const data = this.#read();
    return Object.hasOwn(data, key) ? data[key] : null;
  }

  keys(): string[] {
    return Object.keys(this.#read()).sort();
  }

  /** Set `key`; `null` or `undefined` deletes it. */
  set(key: string, value: unknown): void {
    const data = this.#read();
    if (value === null || value === undefined) {
      delete data[key];
    } else {
      const plain = toPlainJson(value);
      if (!plain.ok)
        throw new PluginStoreError(
          plain.error.replace("a host function returned", "the store got"),
        );
      data[key] = plain.value;
      if (Object.keys(data).length > STORE_MAX_KEYS)
        throw new PluginStoreError(`E_LIMIT: the store holds at most ${STORE_MAX_KEYS} keys`);
    }
    const text = JSON.stringify(data);
    if (Buffer.byteLength(text, "utf8") > STORE_MAX_BYTES)
      throw new PluginStoreError("E_LIMIT: the store may hold at most 1 MiB");
    writeFileAtomic(this.#path, text);
  }
}
