import { watch as fsWatch, type FSWatcher } from "node:fs";
import { join, sep } from "node:path";

export interface WatchEvent {
  type: "create" | "update" | "delete";
  path: string;
}

/**
 * File watching that survives BOTH runtimes. In a dev checkout / node install
 * we use `@parcel/watcher` (fast, native, recursive with real ignore globs).
 * In the compiled `tmux-ide-tui` binary that native `.node` addon can't be
 * embedded by `bun build --compile`, so importing it throws — we catch that
 * once and fall back to node's builtin `fs.watch`. The fallback is coarser
 * (segment-level ignores, synthesized "update" events) but keeps the explorer
 * and changes surfaces live instead of crashing on boot.
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

// undefined = not attempted yet, null = confirmed unavailable (compiled binary).
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
): () => Promise<void> {
  const ignoreSet = new Set(ignore);
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let handle: FSWatcher | null = null;
  try {
    handle = fsWatch(dir, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = filename.toString();
      if (rel.split(sep).some((part) => ignoreSet.has(part))) return;
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => onChange([{ type: "update", path: join(dir, rel) }]), debounceMs);
    });
  } catch {
    // Directory may be unreadable/vanished — degrade to a no-op watcher.
  }
  return async () => {
    if (timeout) clearTimeout(timeout);
    handle?.close();
  };
}

export async function watchDirectory(
  dir: string,
  onChange: (events: WatchEvent[]) => void,
  options?: { debounceMs?: number; ignore?: string[] },
): Promise<() => Promise<void>> {
  const debounceMs = options?.debounceMs ?? 300;
  const ignore = options?.ignore ?? ["node_modules", ".git", "dist", "build", ".next"];

  const native = await loadParcel();
  if (!native) return fsWatchDirectory(dir, onChange, ignore, debounceMs);

  let timeout: ReturnType<typeof setTimeout> | null = null;
  const subscription = await native.subscribe(
    dir,
    (err, events) => {
      if (err) return;
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => onChange(events as unknown as WatchEvent[]), debounceMs);
    },
    { ignore },
  );

  return async () => {
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
        if (events.some((e) => e.path.endsWith("HEAD"))) {
          onBranchChange();
        }
      },
      { ignore: ["objects", "pack", "refs", "logs"] },
    );
    return () => subscription.unsubscribe();
  } catch {
    return null;
  }
}
