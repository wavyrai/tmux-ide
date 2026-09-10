/* @jsxImportSource @opentui/solid */
import type { JSX } from "@opentui/solid";
import { createContext, onCleanup, useContext } from "solid-js";

export interface RoutedKeyboardEvent {
  readonly name: string;
  readonly eventType: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

export type KeyboardRoute = (event: RoutedKeyboardEvent) => boolean;

export interface KeyboardRouteOwner {
  register(route: KeyboardRoute): () => void;
  registerPaste(route: (bytes: Uint8Array) => boolean): () => void;
  routePaste(bytes: Uint8Array): boolean;
  route(event: RoutedKeyboardEvent): boolean;
  dispose(): void;
  readonly size: number;
}

/** One application keyboard ingress with component-local semantic routes. */
export function createKeyboardRouteOwner(): KeyboardRouteOwner {
  const routes: KeyboardRoute[] = [];
  const pasteRoutes: ((bytes: Uint8Array) => boolean)[] = [];
  return {
    registerPaste(route) {
      pasteRoutes.push(route);
      return () => {
        const index = pasteRoutes.lastIndexOf(route);
        if (index >= 0) pasteRoutes.splice(index, 1);
      };
    },
    routePaste(bytes) {
      for (let index = pasteRoutes.length - 1; index >= 0; index--)
        if (pasteRoutes[index]!(bytes)) return true;
      return false;
    },
    register(route) {
      routes.push(route);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const index = routes.lastIndexOf(route);
        if (index >= 0) routes.splice(index, 1);
      };
    },
    route(event) {
      for (let index = routes.length - 1; index >= 0; index -= 1) {
        if (routes[index]!(event)) return true;
      }
      return false;
    },
    dispose() {
      routes.length = 0;
      pasteRoutes.length = 0;
    },
    get size() {
      return routes.length;
    },
  };
}

const KeyboardRouteContext = createContext<KeyboardRouteOwner | null>(null);

export function KeyboardRouteProvider(props: {
  readonly owner: KeyboardRouteOwner;
  readonly children: JSX.Element;
}) {
  return (
    <KeyboardRouteContext.Provider value={props.owner}>
      {props.children}
    </KeyboardRouteContext.Provider>
  );
}

/** Register with the root owner; a standalone primitive remains pointer-only. */
export function useKeyboardRoute(route: KeyboardRoute): void {
  const owner = useContext(KeyboardRouteContext);
  if (!owner) return;
  const unregister = owner.register(route);
  onCleanup(unregister);
}

/** Component-local paste ownership; physical ingress remains at the application root. */
export function usePasteRoute(route: (bytes: Uint8Array) => boolean): void {
  const owner = useContext(KeyboardRouteContext);
  if (owner) onCleanup(owner.registerPaste(route));
}
