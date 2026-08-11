import { watch as fsWatch, type FSWatcher } from "node:fs";
import { join, sep } from "node:path";

export interface WatchEvent {
  type: "create" | "update" | "delete";
  path: string;
}

/**
 * Runtime-neutral directory observation shared by the daemon engine and its
 * UI adapters. The optional Parcel backend is preferred in a Node checkout;
 * compiled Bun binaries fall back to `fs.watch` without reversing the engine
 * dependency graph into a widget module.
 */
interface ParcelSubscription {
  unsubscribe(): Promise<void>;
}

interface ParcelWatcher {
  subscribe(
    dir: string,
    cb: (err: Error | null, events: { type: string; path: string }[]) => void,
    opts?: { ignore?: string[] },
  ): Promise<ParcelSubscription>;
}

let parcel: ParcelWatcher | null | undefined;

async function loadParcel(): Promise<ParcelWatcher | null> {
  if (parcel !== undefined) return parcel;
  try {
    const mod = (await import("@parcel/watcher")) as unknown as ParcelWatcher;
    if (typeof mod.subscribe !== "function") throw new Error("no subscribe");
    parcel = mod;
  } catch {
    parcel = null;
  }
  return parcel;
}

function fsWatchDirectory(
  dir: string,
  onChange: (events: WatchEvent[]) => void,
  ignore: string[],
  debounceMs: number,
  requireInstalled: boolean,
  onUnavailable: (error: Error) => void,
): () => Promise<void> {
  const ignoreSet = new Set(ignore);
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let handle: FSWatcher | null = null;
  let stopping = false;
  let unavailable = false;
  const reportUnavailable = (error: Error): void => {
    if (stopping || unavailable) return;
    unavailable = true;
    onUnavailable(error);
  };
  try {
    handle = fsWatch(dir, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = filename.toString();
      if (rel.split(sep).some((part) => ignoreSet.has(part))) return;
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => onChange([{ type: "update", path: join(dir, rel) }]), debounceMs);
    });
    handle.on("error", reportUnavailable);
    handle.on("close", () => {
      reportUnavailable(new Error(`Directory watcher closed unexpectedly for ${dir}`));
    });
  } catch (error) {
    if (requireInstalled) throw error;
  }
  return async () => {
    stopping = true;
    if (timeout) clearTimeout(timeout);
    handle?.close();
  };
}

export async function watchDirectory(
  dir: string,
  onChange: (events: WatchEvent[]) => void,
  options?: {
    debounceMs?: number;
    ignore?: string[];
    requireInstalled?: boolean;
    /** Called once when an installed native watcher dies unexpectedly. */
    onUnavailable?: (error: Error) => void;
  },
): Promise<() => Promise<void>> {
  const debounceMs = options?.debounceMs ?? 300;
  const ignore = options?.ignore ?? ["node_modules", ".git", "dist", "build", ".next"];

  const native = await loadParcel();
  if (!native) {
    return fsWatchDirectory(
      dir,
      onChange,
      ignore,
      debounceMs,
      options?.requireInstalled ?? false,
      options?.onUnavailable ?? (() => undefined),
    );
  }

  let timeout: ReturnType<typeof setTimeout> | null = null;
  let stopping = false;
  let unavailable = false;
  const reportUnavailable = (error: Error): void => {
    if (stopping || unavailable) return;
    unavailable = true;
    options?.onUnavailable?.(error);
  };
  const subscription = await native.subscribe(
    dir,
    (err, events) => {
      if (err) {
        reportUnavailable(err);
        return;
      }
      if (stopping || unavailable) return;
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => onChange(events as unknown as WatchEvent[]), debounceMs);
    },
    { ignore },
  );

  return async () => {
    stopping = true;
    if (timeout) clearTimeout(timeout);
    await subscription.unsubscribe();
  };
}

export async function watchGitHead(
  dir: string,
  onBranchChange: () => void,
): Promise<(() => Promise<void>) | null> {
  const gitDir = join(dir, ".git");
  const native = await loadParcel();
  if (!native) {
    try {
      const handle = fsWatch(gitDir, (_event, filename) => {
        if (filename && filename.toString().endsWith("HEAD")) onBranchChange();
      });
      return async () => handle.close();
    } catch {
      return null;
    }
  }

  try {
    const subscription = await native.subscribe(
      gitDir,
      (err, events) => {
        if (err) return;
        if (events.some((event) => event.path.endsWith("HEAD"))) onBranchChange();
      },
      { ignore: ["objects", "pack", "refs", "logs"] },
    );
    return () => subscription.unsubscribe();
  } catch {
    return null;
  }
}
