import { useSyncExternalStore } from "react";
import {
  DesktopIconCatalogSchemaZ,
  type DesktopIconCatalog,
  type HostCapabilities,
  type SemanticIconName,
} from "@tmux-ide/contracts";

const OPEN: DesktopIconCatalog = { provider: "open" };

/** A per-renderer store: one finite host request, no UA sniffing or image downloads. */
export function createIconStore(host?: Pick<HostCapabilities, "icons">) {
  let catalog = OPEN;
  let started = false;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => catalog,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (!started) {
        started = true;
        void Promise.resolve()
          .then(() => host?.icons?.getCatalog())
          .then((value) => {
            if (!value) return;
            const parsed = DesktopIconCatalogSchemaZ.safeParse(value);
            if (!parsed.success) return;
            catalog = parsed.data;
            for (const notify of listeners) notify();
          })
          .catch(() => {
            /* Host failure retains open icons. */
          });
      }
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
let store: ReturnType<typeof createIconStore> | undefined;
export function useNativeIcon(name: SemanticIconName): string | undefined {
  store ??= createIconStore(typeof window === "undefined" ? undefined : window.tmuxIdeHost);
  const catalog = useSyncExternalStore(store.subscribe, store.getSnapshot, () => OPEN);
  return catalog.provider === "sf-symbols" ? catalog.icons[name] : undefined;
}
