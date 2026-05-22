import type { TmuxPaneTarget } from "@tmux-ide/contracts";
import type { TmuxPaneInfo } from "./panes.ts";

export type { TmuxPaneTarget } from "@tmux-ide/contracts";

export interface ResolvedPane {
  /** tmux target string suitable for passing to `-t` */
  target: string;
  pane: TmuxPaneInfo;
}

/**
 * Resolve a typed `TmuxPaneTarget` against a list of panes (typically
 * obtained from `listPanes(session)`).
 *
 * Disambiguation rules — the order is important; `byId` matches against
 * the listing's tmux-format `pane_index` field for symmetry with how the
 * CLI passes `%N`-style ids and bare integers, but `byIndex` is preferred
 * when the caller actually knows it's an index. `byTitle` resolves to the
 * single matching pane and throws if there are zero or more than one.
 *
 * `byRole` is resolved one layer up (in the daemon, against the ide.yml
 * role map) and translated to one of the other modes before reaching here;
 * if a `byRole` target arrives at the bridge, that's a layering bug and
 * we throw rather than silently no-op.
 */
export function resolveTarget(
  panes: readonly TmuxPaneInfo[],
  target: TmuxPaneTarget,
  session?: string,
): ResolvedPane {
  switch (target.kind) {
    case "byId": {
      // Pane id may be either a tmux %N id (kept as opaque string) or a
      // bare numeric index. We don't have the %N id in TmuxPaneInfo, so
      // accept "%N" as opaque (caller knows the id) and fall through to
      // index-matching for bare numerics.
      if (target.id.startsWith("%")) {
        // Opaque: trust the caller. We can't validate against panes[].
        return {
          target: target.id,
          pane: panes[0] ?? {
            index: -1,
            title: undefined,
            width: 0,
            height: 0,
            active: false,
          },
        };
      }
      const numeric = Number.parseInt(target.id, 10);
      if (!Number.isFinite(numeric)) {
        throw new Error(`Invalid pane id: ${target.id}`);
      }
      const found = panes.find((p) => p.index === numeric);
      if (!found) {
        throw new Error(`Pane not found by id: ${target.id}`);
      }
      return { target: paneTarget(session, found.index), pane: found };
    }
    case "byIndex": {
      const found = panes.find((p) => p.index === target.index);
      if (!found) {
        throw new Error(`Pane not found by index: ${target.index}`);
      }
      return { target: paneTarget(session, found.index), pane: found };
    }
    case "byTitle": {
      const matches = panes.filter((p) => p.title === target.title);
      if (matches.length === 0) {
        throw new Error(`Pane not found by title: ${target.title}`);
      }
      if (matches.length > 1) {
        throw new Error(`Ambiguous pane title "${target.title}" matches ${matches.length} panes`);
      }
      return {
        target: paneTarget(session, matches[0]!.index),
        pane: matches[0]!,
      };
    }
    case "byRole":
      throw new Error(
        `byRole targets must be resolved at the daemon layer before reaching the bridge (got role="${target.role}")`,
      );
  }
}

function paneTarget(session: string | undefined, index: number): string {
  return session ? `${session}.${index}` : String(index);
}
