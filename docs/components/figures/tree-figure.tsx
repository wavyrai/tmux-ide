import "./pane-figure.css";
import type { ReactNode } from "react";
import { HarnessMark, type Mark, type Status } from "@/components/figures/pane-figure";

/**
 * A static figure drawn like the Home fleet tree: one mono row per node with
 * its status glyph, harness mark, name, role and id, hairline tree guides for
 * nesting, inline flow labels, and notes in the right margin. Built for the
 * docs column, where a full pane stage would be heavy.
 */

const GLYPH: Record<Status, string> = { working: "●", blocked: "!", done: "✓", idle: "○" };

export type TreeRow = {
  depth: 0 | 1 | 2;
  status?: Status;
  mark?: Mark;
  name: string;
  role: string;
  meta?: string;
  flow?: string;
  note?: { letter: string; label: string; text: ReactNode };
  duty?: string;
};

/** For each row: which ancestor columns continue past it, and whether it is its parent's last child. */
function guides(rows: readonly TreeRow[]) {
  return rows.map((row, index) => {
    const later = rows.slice(index + 1);
    const nextAt = (depth: number) => {
      for (const next of later) {
        if (next.depth < depth) return false;
        if (next.depth === depth) return true;
      }
      return false;
    };
    return {
      last: !nextAt(row.depth),
      through: [1, 2].filter((depth) => depth < row.depth && nextAt(depth)),
    };
  });
}

export function TreeFigure(props: {
  id: string;
  number: string;
  kicker: string;
  title: string;
  session: string;
  rows: readonly TreeRow[];
  foundation?: readonly string[];
  caption: ReactNode;
  reading?: { lead: string; text: ReactNode };
}) {
  const { id, rows } = props;
  const lines = guides(rows);
  return (
    <figure className="tf not-prose" aria-labelledby={`${id}-caption`}>
      <p className="pf-kicker type-caption-1 font-mono">{props.kicker}</p>
      <p className="tf-title type-title-2">{props.title}</p>
      <div className="tf-frame">
        <p className="tf-bar type-caption-1 font-mono">
          <span>{props.session}</span>
          <span className="pf-key">
            {(["working", "blocked", "done", "idle"] as const).map((status) => (
              <span key={status} className={`pf-${status}`}>
                {GLYPH[status]} {status}
              </span>
            ))}
          </span>
        </p>
        <ol className="tf-list">
          {rows.map((row, index) => (
            <li
              key={row.name + row.role}
              className={`tf-row tf-d${row.depth}`}
              data-last={lines[index]!.last || undefined}
            >
              <div className="tf-main">
                {lines[index]!.through.map((depth) => (
                  <i key={depth} aria-hidden className={`tf-rail tf-c${depth}`} />
                ))}
                {row.depth > 0 ? <i aria-hidden className="tf-elbow" /> : null}
                <span className={`tf-glyph pf-${row.status ?? "idle"}`} aria-hidden>
                  {row.status ? GLYPH[row.status] : "·"}
                </span>
                {row.mark ? <HarnessMark mark={row.mark} /> : null}
                <span className="tf-name type-body font-mono text-fd-foreground">{row.name}</span>
                <span className="tf-role type-caption-1">{row.role}</span>
                {row.meta ? (
                  <span className={`tf-meta type-caption-1 font-mono pf-${row.status ?? "dim"}`}>
                    {row.meta}
                  </span>
                ) : null}
                {row.flow ? (
                  <span className="tf-flow type-caption-2 font-mono">{row.flow}</span>
                ) : null}
              </div>
              <p className="tf-note type-body-2">
                {row.note ? (
                  <>
                    <span className="font-mono text-fd-foreground">{row.note.letter}.</span>{" "}
                    <span className="text-fd-foreground">{row.note.label}.</span> {row.note.text}
                  </>
                ) : (
                  row.duty
                )}
              </p>
            </li>
          ))}
        </ol>
        {props.foundation ? (
          <p className="tf-found type-caption-1 font-mono">
            {props.foundation.map((item, index) => (
              <span key={item} className={index === 0 ? "text-fd-foreground" : undefined}>
                {item}
              </span>
            ))}
          </p>
        ) : null}
      </div>
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
