type Migration = (prev: unknown) => unknown;

export interface PersistStore<T> {
  read(): T;
  write(data: T): void;
  clear(): void;
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function storage(): StorageLike | null {
  if (!canUseStorage()) return null;
  return window.localStorage;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function versionKey(key: string, version: string): string {
  return version ? `${key}.${version}` : key;
}

function isQuotaExceeded(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: string }).name;
  if (name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED") return true;
  const code = (error as { code?: number }).code;
  if (code === 22 || code === 1014) return true;
  const message = (error as { message?: string }).message;
  return typeof message === "string" && /quota/i.test(message);
}

function parse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function applyMigrations(
  value: unknown,
  fromIndex: number,
  versions: string[],
  migrations: Record<string, Migration>,
): unknown {
  let current = value;
  for (const version of versions.slice(fromIndex + 1)) {
    const migrate = migrations[version];
    if (migrate) current = migrate(current);
  }
  return current;
}

function evictOldestVersionedKey(store: StorageLike, keys: string[], currentKey: string): void {
  const oldest = keys.find(
    (candidate) => candidate !== currentKey && store.getItem(candidate) !== null,
  );
  if (oldest) {
    store.removeItem(oldest);
    return;
  }

  for (let index = 0; index < store.length; index += 1) {
    const candidate = store.key(index);
    if (!candidate || candidate === currentKey) continue;
    if (keys.includes(candidate)) {
      store.removeItem(candidate);
      return;
    }
  }
}

export const Persist = {
  global<T>(
    key: string,
    versions: string[],
    defaults: T,
    migrations: Record<string, Migration> = {},
  ): PersistStore<T> {
    const keys = versions.length > 0 ? versions.map((version) => versionKey(key, version)) : [key];
    const currentKey = keys[keys.length - 1] ?? key;

    return {
      read(): T {
        const store = storage();
        if (!store) return clone(defaults);

        for (let index = keys.length - 1; index >= 0; index -= 1) {
          const candidate = keys[index];
          if (!candidate) continue;
          const raw = store.getItem(candidate);
          if (raw === null) continue;

          const parsed = parse(raw);
          if (parsed === undefined) {
            store.removeItem(candidate);
            continue;
          }

          return applyMigrations(parsed, index, versions, migrations) as T;
        }

        return clone(defaults);
      },

      write(data: T): void {
        const store = storage();
        if (!store) return;

        const value = JSON.stringify(data);
        try {
          store.setItem(currentKey, value);
          return;
        } catch (error) {
          if (!isQuotaExceeded(error)) throw error;
          console.warn(`localStorage quota exceeded while writing ${currentKey}`);
        }

        try {
          evictOldestVersionedKey(store, keys, currentKey);
          store.setItem(currentKey, value);
        } catch (error) {
          if (!isQuotaExceeded(error)) throw error;
          console.warn(`localStorage quota retry failed for ${currentKey}`);
        }
      },

      clear(): void {
        const store = storage();
        if (!store) return;
        for (const candidate of keys) {
          store.removeItem(candidate);
        }
      },
    };
  },
};
