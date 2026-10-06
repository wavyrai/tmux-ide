import { cn } from "@/lib/cn";
import type { CSSProperties } from "react";
import { SpriteIcon } from "@/components/icons/sprite-icon";
// Cached CSS chunk, not page HTML: the rules would otherwise ship twice (HTML + RSC).
import "./tui-cursor.css";

/**
 * Named, multiplayer-style cursors over the rendered app: an arrow in the
 * actor's colour (white outline, soft shadow) with a name pill. The arrow is
 * the `cursor-arrow` symbol in the cached icon sprite, painted via `color`; movement is CSS-only (transform and
 * opacity, tui-cursor.css), so the cursors cost no client JavaScript.
 *
 * A cursor's track is a layer the size of its container, so `translate()`
 * percentages are percentages of the figure, matching the points
 * `pnpm demo:tui` records for each action.
 */
export type CursorActor = "You" | "Claude Code" | "Codex";

const ACTOR: Record<CursorActor, string> = {
  You: "you",
  "Claude Code": "claude",
  Codex: "codex",
};

/** [x, y] in % of the container (JSON imports widen tuples to arrays). */
type Point = readonly number[];
const pct = ([x = 0, y = 0]: Point) => [`${x}%`, `${y}%`] as const;

/** Track variables for a from → at → to path, in % of the container. */
export function cursorPath(from: Point, at: Point, to: Point): CSSProperties {
  const [fx, fy] = pct(from);
  const [ax, ay] = pct(at);
  const [tx, ty] = pct(to);
  return {
    "--fx": fx,
    "--fy": fy,
    "--ax": ax,
    "--ay": ay,
    "--tx": tx,
    "--ty": ty,
  } as CSSProperties;
}

export function TuiCursor({
  actor,
  className,
  style,
  flip = false,
}: {
  actor: CursorActor;
  className?: string;
  style?: CSSProperties;
  /** Put the name pill left of the arrow (paths that reach the right edge). */
  flip?: boolean;
}) {
  return (
    <span className={cn("tui-cursor-track", className)} style={style}>
      <span className={cn("tui-cursor", `tui-cursor-${ACTOR[actor]}`, flip && "tui-cursor-flip")}>
        <SpriteIcon name="cursor-arrow" size={20} className="tui-cursor-arrow" />
        <span className="tui-cursor-label">{actor}</span>
      </span>
    </span>
  );
}

/** Fig. 01 overlay: sits exactly over the hero image, never takes input. */
export function TuiHeroCursors() {
  return (
    <div className="tui-hero-cursors" aria-hidden="true">
      <TuiCursor actor="You" className="tui-hero-you" flip />
      <TuiCursor actor="Codex" className="tui-hero-codex" />
    </div>
  );
}
