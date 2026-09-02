import { cn } from "@/lib/cn";
import type { CSSProperties } from "react";
import { TechnicalCaption } from "./technical-caption";

export type TuiFigureVariant =
  | "names"
  | "status"
  | "navigate"
  | "window"
  | "split"
  | "resize"
  | "rename"
  | "focus"
  | "close"
  | "tmux"
  | "daemon"
  | "opentui";

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

const labels: Record<TuiFigureVariant, string> = {
  names: "A TUI sidebar giving agents memorable names",
  status: "A TUI agent list showing working, idle, attention, and done states",
  navigate: "A TUI navigation path from an agent in the sidebar to its exact pane",
  window: "A TUI window bar with a new-window control",
  split: "A terminal window split into two panes",
  resize: "Two terminal panes with an adjustable divider",
  rename: "A generic shell pane renamed to a memorable agent name",
  focus: "A focused terminal pane among several panes",
  close: "A terminal pane with an explicit close control",
  tmux: "tmux sessions, windows, and panes as the durable base layer",
  daemon: "The tmux-ide daemon projecting events into a workspace model",
  opentui: "The OpenTUI presenting sessions, agents, and terminal panes",
};

const accent = "var(--color-fd-primary)";
const ink = "var(--color-fd-foreground)";
const muted = "var(--color-fd-muted-foreground)";
const line = "var(--color-marketing-line)";

const sequence: Record<TuiFigureVariant, { count: 3 | 6; index: number }> = {
  names: { count: 3, index: 0 },
  status: { count: 3, index: 1 },
  navigate: { count: 3, index: 2 },
  window: { count: 6, index: 0 },
  split: { count: 6, index: 1 },
  resize: { count: 6, index: 2 },
  rename: { count: 6, index: 3 },
  focus: { count: 6, index: 4 },
  close: { count: 6, index: 5 },
  tmux: { count: 3, index: 0 },
  daemon: { count: 3, index: 1 },
  opentui: { count: 3, index: 2 },
};

function Frame() {
  return (
    <>
      <rect x="0.5" y="0.5" width="359" height="139" fill="none" stroke={line} />
      <path d="M1 25.5H359" stroke={line} />
      <circle cx="13" cy="13" r="3" fill={accent} />
      <text x="24" y="17" fill={muted} fontSize="9">
        tmux-ide / workspace
      </text>
    </>
  );
}

function AgentFigure({ variant }: { variant: "names" | "status" | "navigate" }) {
  if (variant === "status") {
    return (
      <>
        <Frame />
        <rect className="tui-motion-after" x="10" y="70" width="340" height="22" fill={line} />
        {[
          [42, "●", "talented-toucan", "working"],
          [64, "○", "warm-redwood", "idle"],
          [86, "!", "zesty-heron", "attention"],
          [108, "✓", "rapid-comet", "done"],
        ].map(([y, mark, name, state]) => (
          <g key={name}>
            <text x="17" y={Number(y)} fill={state === "attention" ? accent : muted} fontSize="10">
              {mark}
            </text>
            <text x="35" y={Number(y)} fill={ink} fontSize="10">
              {name}
            </text>
            <text x="250" y={Number(y)} fill={state === "working" ? accent : muted} fontSize="9">
              {state}
            </text>
          </g>
        ))}
      </>
    );
  }

  return (
    <>
      <Frame />
      <path d="M118 26V139" stroke={line} />
      <rect className="tui-motion-before" x="9" y="40" width="100" height="21" fill={line} />
      <rect className="tui-motion-after" x="9" y="65" width="100" height="21" fill={line} />
      <text x="17" y="54" fill={ink} fontSize="9">
        talented-toucan
      </text>
      <text x="17" y="79" fill={muted} fontSize="9">
        warm-redwood
      </text>
      <text x="17" y="101" fill={muted} fontSize="9">
        zesty-heron
      </text>
      <text className="tui-motion-before" x="130" y="47" fill={accent} fontSize="9">
        talented-toucan [working]
      </text>
      <text className="tui-motion-after" x="130" y="47" fill={accent} fontSize="9">
        warm-redwood [idle]
      </text>
      <path d="M130 58H341M130 70H295M130 82H322" stroke={line} />
      {variant === "navigate" ? (
        <>
          <path
            className="tui-motion-after"
            d="M104 50C150 50 159 101 224 101H322"
            fill="none"
            stroke={accent}
            strokeWidth="1.5"
          />
          <path
            className="tui-motion-after"
            d="m317 96 6 5-6 5"
            fill="none"
            stroke={accent}
            strokeWidth="1.5"
          />
          <rect
            className="tui-motion-after"
            x="224"
            y="92"
            width="112"
            height="20"
            fill="none"
            stroke={accent}
          />
        </>
      ) : null}
    </>
  );
}

function ControlFigure({
  variant,
}: {
  variant: "window" | "split" | "resize" | "rename" | "focus" | "close";
}) {
  const divided = variant === "split" || variant === "resize" || variant === "focus";
  return (
    <>
      <Frame />
      <rect x="10" y="36" width="340" height="92" fill="none" stroke={line} />
      <path d="M10 55H350" stroke={line} />
      <text x="20" y="49" fill={ink} fontSize="9">
        {variant === "rename"
          ? "talented-toucan"
          : variant === "window"
            ? "1: workspace"
            : "agent workspace"}
      </text>
      {variant === "window" ? (
        <>
          <text className="tui-motion-before" x="306" y="49" fill={accent} fontSize="9">
            + new
          </text>
          <rect className="tui-motion-after" x="180" y="37" width="104" height="17" fill={line} />
          <text className="tui-motion-after" x="190" y="49" fill={ink} fontSize="9">
            2: agent
          </text>
        </>
      ) : null}
      {divided && variant !== "resize" ? (
        <path className="tui-motion-after" d="M198 55V128" stroke={line} />
      ) : null}
      {variant === "resize" ? (
        <>
          <path className="tui-motion-before" d="M188 55V128" stroke={line} />
          <path className="tui-motion-after" d="M220 55V128" stroke={accent} strokeWidth="2" />
          <text className="tui-motion-after" x="205" y="95" fill={accent} fontSize="13">
            ↔
          </text>
        </>
      ) : null}
      {variant === "rename" ? (
        <>
          <text className="tui-motion-before" x="20" y="79" fill={muted} fontSize="9">
            0:zsh
          </text>
          <path className="tui-motion-before" d="M66 76H137" stroke={line} />
          <text className="tui-motion-after" x="20" y="79" fill={accent} fontSize="9">
            talented-toucan
          </text>
        </>
      ) : (
        <>
          <path
            className={variant === "focus" ? "tui-motion-before" : undefined}
            d="M22 72H123M22 83H158M22 94H104"
            stroke={variant === "focus" ? accent : line}
          />
          {divided ? (
            <path
              className="tui-motion-after"
              d="M212 72H319M212 83H288M212 94H331"
              stroke={variant === "focus" ? accent : line}
            />
          ) : null}
        </>
      )}
      {variant === "close" ? (
        <>
          <rect x="302" y="39" width="38" height="13" fill={accent} />
          <text x="315" y="49" fill="var(--color-fd-primary-foreground)" fontSize="9">
            ×
          </text>
          <text className="tui-motion-after" x="136" y="99" fill={accent} fontSize="9">
            ✓ pane closed
          </text>
        </>
      ) : null}
    </>
  );
}

function ArchitectureFigure({ variant }: { variant: "tmux" | "daemon" | "opentui" }) {
  return (
    <>
      <Frame />
      {variant === "tmux" ? (
        <>
          <rect x="20" y="43" width="320" height="74" fill="none" stroke={line} />
          <path d="M20 64H340M126 64V117M235 64V117" stroke={line} />
          <text x="29" y="57" fill={accent} fontSize="9">
            session
          </text>
          <text x="48" y="91" fill={ink} fontSize="9">
            pane 0
          </text>
          <text x="155" y="91" fill={ink} fontSize="9">
            pane 1
          </text>
          <text x="263" y="91" fill={ink} fontSize="9">
            pane 2
          </text>
          <rect
            className="tui-motion-after"
            x="127"
            y="65"
            width="107"
            height="51"
            fill="none"
            stroke={accent}
          />
        </>
      ) : variant === "daemon" ? (
        <>
          <rect x="126" y="51" width="108" height="48" fill="none" stroke={accent} />
          <text x="153" y="79" fill={ink} fontSize="10">
            daemon
          </text>
          <path className="tui-motion-before" d="M20 75H126M234 75H340" stroke={line} />
          <path className="tui-motion-after" d="M20 75H126M234 75H340" stroke={accent} />
          <path
            className="tui-motion-after"
            d="m119 70 7 5-7 5M333 70l7 5-7 5"
            fill="none"
            stroke={accent}
          />
          <text x="25" y="64" fill={muted} fontSize="8">
            tmux events
          </text>
          <text x="262" y="64" fill={muted} fontSize="8">
            workspace
          </text>
        </>
      ) : (
        <>
          <rect x="16" y="40" width="328" height="82" fill="none" stroke={line} />
          <path d="M99 40V122M99 59H344M220 59V122" stroke={line} />
          <rect x="23" y="51" width="68" height="15" fill={line} />
          <text x="29" y="62" fill={ink} fontSize="8">
            agents
          </text>
          <text x="109" y="53" fill={accent} fontSize="8">
            talented-toucan
          </text>
          <text x="230" y="53" fill={muted} fontSize="8">
            warm-redwood
          </text>
          <rect
            className="tui-motion-after"
            x="220"
            y="59"
            width="124"
            height="63"
            fill="none"
            stroke={accent}
          />
        </>
      )}
    </>
  );
}

export function TuiMiniFigure({ variant, figure, className, motionCount, motionIndex }: Props) {
  const defaultMotion = sequence[variant];
  const figureId = `figure-${figure.number.replaceAll(".", "-")}`;
  const motion = {
    count: motionCount ?? defaultMotion.count,
    index: motionIndex ?? defaultMotion.index,
  };
  const style = { "--mockup-delay": `${motion.index * 4}s` } as CSSProperties;

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
          viewBox="0 0 360 140"
          role="img"
          aria-label={labels[variant]}
          className="block h-auto w-full font-mono"
        >
          {variant === "names" || variant === "status" || variant === "navigate" ? (
            <AgentFigure variant={variant} />
          ) : variant === "tmux" || variant === "daemon" || variant === "opentui" ? (
            <ArchitectureFigure variant={variant} />
          ) : (
            <ControlFigure variant={variant} />
          )}
        </svg>
        <img
          src={`/mockup-motion/${variant}.svg`}
          alt=""
          aria-hidden="true"
          loading="eager"
          decoding="async"
          className="tui-motion-cursor pointer-events-none absolute inset-0 block h-full w-full select-none"
        />
      </div>
      <TechnicalCaption id={`${figureId}-caption`} number={figure.number}>
        {figure.label}
      </TechnicalCaption>
    </figure>
  );
}
