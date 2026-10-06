import "./pane-figure.css";
import type { ReactNode } from "react";
import { SPRITE } from "@/components/icons/sprite-url";

/**
 * A figure drawn as a tmux-ide session: a top bar with window tabs, pane
 * frames with the app's header (status glyph, harness mark, command, pane id)
 * and Geist Mono screens, joined by hairline buses. The stage follows the site
 * theme with the app's default Light and Dark pane colours.
 *
 * Motion is CSS only. Elements carry timing classes from pane-figure.css,
 * named by their place in one shared loop (percent of --pf-loop):
 * - oA      a pane opens at A% and stays until the reset
 * - vA-B    visible from A% to B%; B = 94 means it stays until the reset
 * - dA, uA  a bus draws downward / upward from A%
 * - tA-B    a typed line reveals from A% to B%
 * Base styles are the settled final frame, so reduced motion (and any
 * renderer without animation) shows the finished state.
 */

export type Status = "working" | "blocked" | "done" | "idle";
export type Mark = "claude-code" | "codex" | "opencode";

const GLYPH: Record<Status, string> = { working: "●", blocked: "!", done: "✓", idle: "○" };

export type PaneLine = {
  text: string;
  /** Timing class; omitted lines are always shown. */
  t?: string;
  tone?: Status | "dim";
  /** A typed line: t must be a tA-B class. */
  typed?: boolean;
};

/** One status in the pane's timeline: the header glyph and its screen line. */
export type PaneState = { status: Status; text: string; t?: string; spin?: boolean };

export type Pane = {
  id: string;
  cmd: string;
  role: string;
  mark?: Mark;
  /** Timing class for the pane opening. */
  open?: string;
  lines: readonly PaneLine[];
  states?: readonly PaneState[];
  /** Timing class for the attention frame. */
  alert?: string;
};

export type PaneRow = { win: string; tab?: string; panes: readonly Pane[] };

export type PaneLink = {
  down: string;
  up: string;
  /** Timing classes: bus draws and label fades; omitted means static. */
  t?: { down: string; up: string; dl: string; ul: string };
  /** Timing classes for brief highlights that travel the buses. */
  hi?: { down?: string; up?: string };
};

export type PaneFigureProps = {
  id: string;
  /** Story class that scopes the figure's loop. */
  story?: string;
  kicker: string;
  title: string;
  accent?: string;
  subtitle?: ReactNode;
  heading?: "h2" | "h3" | "p";
  session: string;
  /** Accessible summary of the stage (its panes are presentational). */
  label: string;
  rows: readonly PaneRow[];
  links: readonly PaneLink[];
  notes: readonly { letter: string; label: string; text: ReactNode }[];
  number: string;
  caption: ReactNode;
  reading?: { lead: string; text: ReactNode };
};

/** A harness mark from the icon sprite, coloured per brand and theme in CSS. */
export function HarnessMark({ mark }: { mark: Mark }) {
  return (
    <svg width="12" height="12" aria-hidden className={`pf-mark pf-mark-${mark}`}>
      <use href={`${SPRITE}#${mark}`} />
    </svg>
  );
}

function cls(...names: (string | false | undefined)[]) {
  return names.filter(Boolean).join(" ");
}

function PaneFrame({ pane }: { pane: Pane }) {
  const states = pane.states ?? [];
  return (
    <li className={cls("pf-pane", pane.open)}>
      {pane.alert ? <i className={cls("pf-alert", pane.alert)} /> : null}
      <p className="pf-head">
        <span className="pf-stack">
          {states.map((state) => (
            <b key={state.status + state.t} className={cls(`pf-${state.status}`, state.t)}>
              {GLYPH[state.status]}
            </b>
          ))}
        </span>
        {pane.mark ? <HarnessMark mark={pane.mark} /> : null}
        <span className="pf-cmd">{pane.cmd}</span>
        <span className="pf-role">{pane.role}</span>
        <span className="pf-id">{pane.id}</span>
      </p>
      <div className="pf-scr">
        {pane.lines.map((line) => (
          <p
            key={line.text}
            className={cls(line.tone && `pf-${line.tone}`, line.typed && "pf-type", line.t)}
          >
            {line.text}
          </p>
        ))}
        {states.length > 0 ? (
          <p className="pf-stack">
            {states.map((state) => (
              <span key={state.text} className={cls(`pf-${state.status}`, state.t)}>
                {state.spin ? <i className="pf-spin" /> : null}
                {state.text}
              </span>
            ))}
          </p>
        ) : null}
      </div>
    </li>
  );
}

/** Bus x-positions (%) for n panes laid out at a third of the width each. */
const centers = (n: number) =>
  Array.from({ length: n }, (_, i) => 50 + (i - (n - 1) / 2) * (100 / 3));

function busPath(from: number, to: number, offset: number, y: number) {
  const r = (value: number) => Math.round(value * 10) / 10;
  const xs = centers(from).map((x) => x + offset);
  const ys = centers(to).map((x) => x + offset);
  const lo = Math.min(...xs, ...ys);
  const hi = Math.max(...xs, ...ys);
  return (
    xs.map((x) => `M${r(x)} 0V${y}`).join("") +
    (hi > lo ? `M${r(lo)} ${y}H${r(hi)}` : "") +
    ys.map((x) => `M${r(x)} ${y}V100`).join("")
  );
}

function Wire({ from, to, link }: { from: number; to: number; link: PaneLink }) {
  const down = busPath(from, to, -1.6, 74);
  const up = busPath(from, to, 1.6, 22);
  const left = Math.min(...centers(from)) - 1.6;
  const right = Math.max(...centers(from)) + 1.6;
  return (
    <div className="pf-wire" aria-hidden>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className={link.t?.down}>
        <path d={down} />
        {link.hi?.down ? <path d={down} className={cls("pf-hi", link.hi.down)} /> : null}
      </svg>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className={link.t?.up}>
        <path d={up} className="pf-dash" />
        {link.hi?.up ? <path d={up} className={cls("pf-hi", link.hi.up)} /> : null}
      </svg>
      <span className={cls("pf-l", link.t?.dl)} style={{ right: `${101 - left}%` }}>
        ↓ {link.down}
      </span>
      <span className={cls("pf-l pf-l-up", link.t?.ul)} style={{ left: `${right + 1}%` }}>
        ↑ {link.up}
      </span>
    </div>
  );
}

export function PaneFigure(props: PaneFigureProps) {
  const { id, rows, links } = props;
  const Heading = props.heading ?? "h2";
  return (
    <figure className={cls("pf not-prose", props.story)} aria-labelledby={`${id}-caption`}>
      <p className="pf-kicker type-caption-1 font-mono">{props.kicker}</p>
      <Heading className="pf-title type-display-4 lg:type-display-3">
        {props.title}
        {props.accent ? (
          <span className="block text-fd-muted-foreground">{props.accent}</span>
        ) : null}
      </Heading>
      {props.subtitle ? <p className="pf-sub type-marketing-body">{props.subtitle}</p> : null}
      <div className="pf-stage" role="img" aria-label={props.label}>
        <p className="pf-bar">
          <span className="pf-sess">{props.session}</span>
          {rows.map((row) => (
            <span key={row.win} className={cls("pf-tab", row.tab)}>
              {row.win}
            </span>
          ))}
          <span className="pf-key">
            {(["working", "blocked", "done", "idle"] as const).map((status) => (
              <span key={status} className={`pf-${status}`}>
                {GLYPH[status]} {status}
              </span>
            ))}
          </span>
        </p>
        <div className="pf-body">
          {rows.map((row, index) => (
            <div key={row.win}>
              <div className="pf-row">
                <p className={cls("pf-win", row.tab)}>{row.win}</p>
                <ul className={`pf-panes pf-n${row.panes.length}`}>
                  {row.panes.map((pane) => (
                    <PaneFrame key={pane.id} pane={pane} />
                  ))}
                </ul>
              </div>
              {links[index] && rows[index + 1] ? (
                <Wire
                  from={row.panes.length}
                  to={rows[index + 1]!.panes.length}
                  link={links[index]!}
                />
              ) : null}
            </div>
          ))}
        </div>
      </div>
      <ol className="pf-notes type-body-2">
        {props.notes.map((note) => (
          <li key={note.letter}>
            <span className="font-mono text-fd-foreground">{note.letter}.</span>{" "}
            <span className="text-fd-foreground">{note.label}.</span> {note.text}
          </li>
        ))}
      </ol>
      <figcaption id={`${id}-caption`} className="pf-foot type-caption-1">
        <p>
          <span className="mr-2 font-mono">Fig {props.number}.</span>
          <span className="text-fd-foreground">{props.caption}</span>
        </p>
        {props.reading ? (
          <p>
            <strong>{props.reading.lead}</strong> {props.reading.text}
          </p>
        ) : null}
      </figcaption>
    </figure>
  );
}
