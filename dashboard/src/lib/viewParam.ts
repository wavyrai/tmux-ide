/**
 * Solid port of `dashboard/app/project/[name]/useViewParam.ts`.
 *
 * Reads `?view=<id>` from the current URL and writes it back when the
 * caller updates the view. The default view is dropped from the URL so
 * the canonical link stays `/project/:name`.
 *
 * Built on @solidjs/router's `useSearchParams` so route changes are
 * reactive. The `isViewId` predicate guards against drift between the
 * URL and the in-app union.
 */

import { useSearchParams } from "@solidjs/router";

export function useViewParam<V extends string>(
  defaultView: V,
  isViewId: (value: string) => value is V,
): [() => V, (next: V) => void] {
  const [search, setSearch] = useSearchParams<{ view?: string }>();

  const view = (): V => {
    const raw = search.view;
    if (typeof raw === "string" && isViewId(raw)) return raw;
    return defaultView;
  };

  const setView = (next: V) => {
    if (next === defaultView) {
      setSearch({ view: undefined }, { replace: false });
    } else {
      setSearch({ view: next }, { replace: false });
    }
  };

  return [view, setView];
}
