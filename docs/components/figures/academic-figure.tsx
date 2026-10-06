import type { CSSProperties, ReactNode } from "react";

export type FigureCard = {
  /** Mono caption bar, left: the role. */
  cap: string;
  /** Mono caption bar, right: e.g. "Pane 01". */
  tag?: string;
  name: string;
  /** Mono line under the name, e.g. the command the pane runs. */
  mono?: string;
  duty: string;
};

export type FigureLevel = {
  letter: string;
  name: string;
  note: { label: string; text: string };
  cards: readonly FigureCard[];
};

/** The flows between one level and the next: down is solid, up is dashed. */
export type FigureLink = { down?: string; up?: string };

export type AcademicFigureProps = {
  id: string;
  kicker: string;
  title: string;
  /** A second title line in the muted tone (the section-heading pattern). */
  accent?: string;
  subtitle?: ReactNode;
  heading?: "h2" | "h3";
  /** Docs-column variant: the title takes the docs h3 role instead of the section role. */
  compact?: boolean;
  /** Mono label in the figure bar, e.g. "Delegation and synthesis". */
  label: string;
  legend: { solid: string; dashed?: string };
  levels: readonly FigureLevel[];
  /** links[i] connects levels[i] to levels[i + 1]. */
  links: readonly FigureLink[];
  foundation?: {
    title: string;
    sub: string;
    items: readonly { title: string; sub: string; href?: string }[];
  };
  /** The figure number on its page; the caption reads "Fig {number}. …". */
  number: string;
  caption: ReactNode;
  reading?: { lead: string; text: ReactNode };
};

const pct = (value: number) => `${Math.round(value * 100) / 100}%`;
const centers = (count: number) =>
  Array.from({ length: count }, (_, index) => ((2 * index + 1) / (2 * count)) * 100);

/**
 * The connector band between two levels, drawn from the card counts: a solid
 * bus for the down flow and a dashed, offset bus for the return, as one
 * stretched SVG with non-scaling strokes plus small arrowheads. On narrow
 * screens the drawing hides and the labels stack along a single rule.
 */
function Wire({ from, to, link }: { from: number; to: number; link: FigureLink }) {
  const sources = centers(from);
  const targets = centers(to);
  const offset = 2.5;
  const r = (value: number) => Math.round(value * 10) / 10;
  const bus = (xs: number[], ys: number[], y: number, up: boolean) => {
    const top = xs.map((x) => (up ? `M${r(x)} 0V${y}` : `M${r(x)} 0V${y}`)).join("");
    const lo = Math.min(...xs, ...ys);
    const hi = Math.max(...xs, ...ys);
    const across = hi > lo ? `M${r(lo)} ${y}H${r(hi)}` : "";
    const bottom = ys.map((x) => `M${r(x)} ${y}V100`).join("");
    return top + across + bottom;
  };
  const down = link.down ? sources.map((x) => x - offset) : [];
  const downTo = link.down ? targets.map((x) => x - offset) : [];
  const up = link.up ? sources.map((x) => x + offset) : [];
  const upFrom = link.up ? targets.map((x) => x + offset) : [];

  return (
    <div className="afig-wire" aria-hidden>
      <div className="afig-draw">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none">
          {link.down ? <path d={bus(down, downTo, 45, false)} /> : null}
          {link.up ? <path className="afig-d" d={bus(up, upFrom, 25, true)} /> : null}
        </svg>
        {downTo.map((x) => (
          <i key={`d${x}`} className="afig-a" style={{ left: pct(x) }} />
        ))}
        {up.map((x) => (
          <i key={`u${x}`} className="afig-a afig-a-up" style={{ left: pct(x) }} />
        ))}
        {link.down ? (
          <span
            className="afig-e type-caption-1 font-mono"
            style={{ right: pct(100 - Math.min(...down)) }}
          >
            {link.down}
          </span>
        ) : null}
        {link.up ? (
          <span
            className="afig-e afig-e-up type-caption-1 font-mono"
            style={{ left: pct(Math.max(...up)) }}
          >
            {link.up}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A figure in the site's academic diagram language: a ruled kicker, a title
 * with an accent, a framed figure with a mono bar and legend, lettered levels
 * with side notes, square cards, labelled connectors, an optional foundation
 * strip and a two-part caption. Server-rendered HTML, themed by tokens, and
 * stacked on narrow screens.
 */
export function AcademicFigure(props: AcademicFigureProps) {
  const { id, levels, links } = props;
  const Heading = props.heading ?? "h2";
  const label = "type-caption-1 font-mono";
  return (
    <figure className="afig not-prose" aria-labelledby={`${id}-caption`}>
      <p className={`afig-top ${label}`}>{props.kicker}</p>
      <Heading
        className={`afig-title ${props.compact ? "type-title-2" : "type-display-4 lg:type-display-3"}`}
      >
        {props.title}
        {props.accent ? (
          <span className="block text-fd-muted-foreground">{props.accent}</span>
        ) : null}
      </Heading>
      {props.subtitle ? <p className="afig-sub type-marketing-body">{props.subtitle}</p> : null}
      <div className="afig-frame">
        <div className={`afig-bar ${label}`}>
          <span>{props.label}</span>
          <span className="afig-legend">
            <span>{props.legend.solid}</span>
            {props.legend.dashed ? (
              <span className="afig-legend-d">{props.legend.dashed}</span>
            ) : null}
          </span>
        </div>
        <div className="afig-stage">
          {levels.map((level, index) => (
            <div key={level.letter} className="afig-group">
              <div className="afig-level">
                <p className={`afig-lvl ${label}`}>
                  <span className="text-fd-foreground">{level.letter}</span>
                  {level.name}
                </p>
                <ul className={`afig-cards afig-n${level.cards.length}`}>
                  {level.cards.map((card) => (
                    <li key={card.cap} className="afig-card">
                      <p className={`afig-cap ${label}`}>
                        <span>{card.cap}</span>
                        {card.tag ? <span>{card.tag}</span> : null}
                      </p>
                      <div className="afig-body">
                        <p className="type-title-3">{card.name}</p>
                        {card.mono ? (
                          <p className="afig-mono type-body-2 font-mono">{card.mono}</p>
                        ) : null}
                        <p className="afig-duty type-caption-1">{card.duty}</p>
                      </div>
                    </li>
                  ))}
                </ul>
                <p className="afig-note type-body-2">
                  <strong>
                    {level.letter}. {level.note.label}
                  </strong>
                  {level.note.text}
                </p>
              </div>
              {links[index] && levels[index + 1] ? (
                <Wire
                  from={level.cards.length}
                  to={levels[index + 1]!.cards.length}
                  link={links[index]!}
                />
              ) : null}
            </div>
          ))}
        </div>
        {props.foundation ? (
          <div className="afig-found">
            <p className="afig-found-title type-body font-mono">
              {props.foundation.title}
              <small className="type-caption-2">{props.foundation.sub}</small>
            </p>
            <ul className="type-caption-1">
              {props.foundation.items.map((item) => (
                <li key={item.title}>
                  {item.href ? (
                    <a href={item.href} className="afig-link">
                      {item.title} →
                    </a>
                  ) : (
                    item.title
                  )}
                  <small className="type-caption-2">{item.sub}</small>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      <figcaption id={`${id}-caption`} className="afig-foot type-caption-1">
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
