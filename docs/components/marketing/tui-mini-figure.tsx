import { cn } from "@/lib/cn";
import type { CSSProperties } from "react";
import { TechnicalCaption } from "./technical-caption";
import frames from "./tui-mini-figure-frames.json";
// Glyph faces and themed colour pairs, in the cached CSS chunk rather than the page.
import "./tui-mini-figure-frames.css";
import { TuiCursor, cursorPath } from "./tui-cursor";

/**
 * Landing-page mini-figures. Each is a crop of the real `tmux-ide app`,
 * rendered by `pnpm demo:tui` (docs/scripts/tui-demo-figures.ts) in the app's
 * dark and light themes into one cached sprite, public/tui-figures.svg: the
 * "before" frame, then the cells that change when the named cursor performs
 * the action (see tui-cursor.tsx). Colours arrive as inherited custom
 * properties set per site theme (tui-mini-figure-frames.css), so the figures
 * follow the site theme; glyphs use Fig. 01's Geist Mono subset.
 */
export type TuiFigureVariant =
  | "names"
  | "status"
  | "navigate"
  | "tmux"
  | "daemon"
  | "opentui"
  | "window"
  | "resize"
  | "focus";

type Props = {
  variant: TuiFigureVariant;
  figure: {
    number: string;
    label: string;
  };
  className?: string;
  motionCount?: 3 | 6 | 9;
  motionIndex?: number;
};

const sequence: Record<TuiFigureVariant, { count: 3 | 6; index: number }> = {
  names: { count: 3, index: 0 },
  status: { count: 3, index: 1 },
  navigate: { count: 3, index: 2 },
  tmux: { count: 3, index: 0 },
  daemon: { count: 3, index: 1 },
  opentui: { count: 3, index: 2 },
  window: { count: 3, index: 0 },
  resize: { count: 3, index: 1 },
  focus: { count: 3, index: 2 },
};

export function TuiMiniFigure({ variant, figure, className, motionCount, motionIndex }: Props) {
  const defaultMotion = sequence[variant];
  const figureId = `figure-${figure.number.replaceAll(".", "-")}`;
  const motion = {
    count: motionCount ?? defaultMotion.count,
    index: motionIndex ?? defaultMotion.index,
  };
  const style = { "--mockup-delay": `${motion.index * 4}s` } as CSSProperties;
  const frame = frames.figures[variant];

  return (
    <figure
      id={figureId}
      aria-labelledby={`${figureId}-caption`}
      className={cn("overflow-hidden border border-marketing-line bg-marketing-raise", className)}
    >
      <div
        data-motion-count={motion.count}
        data-motion-index={motion.index}
        style={style}
        className="relative overflow-hidden"
      >
        <svg
          viewBox={`0 0 ${frames.width} ${frames.height}`}
          role="img"
          aria-label={frame.label}
          className="tui-figure block h-auto w-full"
        >
          <use href={`${frames.sprite}#${variant}-before`} />
          <use className="tui-motion-after" href={`${frames.sprite}#${variant}-after`} />
        </svg>
        <div className="tui-figure-cursors" data-kind={frame.cursor.kind} aria-hidden="true">
          <TuiCursor
            style={cursorPath(frame.cursor.from, frame.cursor.at, frame.cursor.to)}
            flip={[frame.cursor.from, frame.cursor.at, frame.cursor.to].some(([x = 0]) => x > 85)}
          />
        </div>
      </div>
      <TechnicalCaption id={`${figureId}-caption`} number={figure.number}>
        {figure.label}
      </TechnicalCaption>
    </figure>
  );
}
