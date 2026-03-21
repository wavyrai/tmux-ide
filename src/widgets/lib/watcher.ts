import * as watcher from "@parcel/watcher";
import { join } from "node:path";

export interface WatchEvent {
  type: "create" | "update" | "delete";
  path: string;
}

export async function watchDirectory(
  dir: string,
  onChange: (events: WatchEvent[]) => void,
  options?: { debounceMs?: number; ignore?: string[] },
): Promise<() => Promise<void>> {
  const debounceMs = options?.debounceMs ?? 300;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const subscription = await watcher.subscribe(
    dir,
    (err, events) => {
      if (err) return;
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => onChange(events as unknown as WatchEvent[]), debounceMs);
    },
    { ignore: options?.ignore ?? ["node_modules", ".git", "dist", "build", ".next"] },
  );

  return () => subscription.unsubscribe();
}

export async function watchGitHead(
  dir: string,
  onBranchChange: () => void,
): Promise<(() => Promise<void>) | null> {
  const gitDir = join(dir, ".git");
  try {
    const subscription = await watcher.subscribe(
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
