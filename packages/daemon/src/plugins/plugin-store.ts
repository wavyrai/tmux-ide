/**
 * `ide.store`: a small JSON key/value store per plugin, kept in the plugin's
 * data directory. Writes are atomic; the whole store is capped.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { toPlainJson } from "./host/lua-state.ts";

export const STORE_MAX_BYTES = 1024 * 1024;
export const STORE_MAX_KEYS = 1000;

export class PluginStoreError extends Error {}

export class PluginStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  #read(): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.#path, "utf8"));
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
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${process.pid}.tmp`;
    writeFileSync(temporary, text, { mode: 0o600 });
    renameSync(temporary, this.#path);
  }
}
