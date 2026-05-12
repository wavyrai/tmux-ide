/**
 * Drop-in design-token replacements for the `@components/*` (tui/) primitives
 * still consumed by `/v2` pages. Each export keeps the original prop surface
 * so the consumer migration is a one-line import rewrite.
 *
 * The visual language follows the design-PR tokens (radius scale, semantic
 * colors, `--font-sans` for non-terminal copy). No ASCII-art chrome; cards
 * render with `rounded-lg border` instead of corner glyphs.
 */

"use client";

import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  ReactNode,
} from "react";
import { forwardRef } from "react";

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

interface CardProps extends HTMLAttributes<HTMLElement> {
  children?: ReactNode;
  /** Section label rendered as an uppercase header. */
  title?: ReactNode;
  /** Legacy "left" / "right" mode hint — ignored in the design-token version
   *  because the chrome is the same on both sides. Accepted to keep the
   *  drop-in API. */
  mode?: string;
}

export function Card({ children, title, mode: _mode, className, style, ...rest }: CardProps) {
  void _mode;
  return (
    <article
      className={`rounded-lg border border-border/45 bg-card/25 p-3 ${className ?? ""}`}
      style={style}
      {...rest}
    >
      {title ? (
        <h2 className="mb-2 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/80">
          {title}
        </h2>
      ) : null}
      <section>{children}</section>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  children?: ReactNode;
}

export function Badge({ children, className, ...rest }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-md border border-border bg-[var(--surface)] px-1.5 py-px text-[10px] uppercase tracking-wider text-muted-foreground ${className ?? ""}`}
      {...rest}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Button — drop-in for tui/Button (theme: "PRIMARY" | "SECONDARY")
// ---------------------------------------------------------------------------

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  theme?: "PRIMARY" | "SECONDARY";
  isDisabled?: boolean;
  children?: ReactNode;
}

export function Button({
  theme = "PRIMARY",
  isDisabled,
  disabled,
  children,
  className,
  ...rest
}: ButtonProps) {
  const effectiveDisabled = isDisabled ?? disabled;
  const base =
    "h-7 shrink-0 cursor-pointer rounded-md px-2.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50";
  const variant =
    theme === "SECONDARY"
      ? "border border-border bg-[var(--surface)] text-foreground hover:bg-[var(--surface-hover)]"
      : "bg-[var(--accent)] text-[var(--bg)] hover:opacity-90";
  return (
    <button
      type="button"
      disabled={effectiveDisabled}
      className={`${base} ${variant} ${className ?? ""}`}
      {...rest}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// RowSpaceBetween — flex row utility
// ---------------------------------------------------------------------------

type RowSpaceBetweenProps = HTMLAttributes<HTMLElement> & {
  children?: ReactNode;
};

export const RowSpaceBetween = forwardRef<HTMLElement, RowSpaceBetweenProps>(
  ({ children, className, ...rest }, ref) => (
    <section
      ref={ref}
      className={`flex items-center justify-between gap-2 ${className ?? ""}`}
      {...rest}
    >
      {children}
    </section>
  ),
);
RowSpaceBetween.displayName = "RowSpaceBetween";

// ---------------------------------------------------------------------------
// CodeBlock — pre with optional line numbers
// ---------------------------------------------------------------------------

interface CodeBlockProps extends HTMLAttributes<HTMLPreElement> {
  children?: ReactNode;
}

export const CodeBlock = forwardRef<HTMLPreElement, CodeBlockProps>(
  ({ children, className, ...rest }, ref) => {
    const lines = String(children ?? "").split("\n");
    return (
      <pre
        ref={ref}
        className={`overflow-x-auto rounded-md border border-border bg-[var(--surface)] p-2 font-mono text-[11px] leading-5 ${className ?? ""}`}
        {...rest}
      >
        {lines.map((line, index) => (
          <div key={index} className="grid grid-cols-[2.5rem_1fr] gap-2">
            <span className="select-none text-right text-subtle-foreground">{index + 1}</span>
            <span>{line}</span>
          </div>
        ))}
      </pre>
    );
  },
);
CodeBlock.displayName = "CodeBlock";

// ---------------------------------------------------------------------------
// Window — section frame
// ---------------------------------------------------------------------------

type WindowProps = HTMLAttributes<HTMLElement> & { children?: ReactNode };

export function Window({ children, className, ...rest }: WindowProps) {
  return (
    <section
      role="dialog"
      className={`rounded-xl border border-border bg-card shadow-sm ${className ?? ""}`}
      {...rest}
    >
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Grid — wrapper div (callers compose with Tailwind grid utilities)
// ---------------------------------------------------------------------------

interface GridProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
}

export function Grid({ children, className, ...rest }: GridProps) {
  return (
    <div className={`grid gap-2 ${className ?? ""}`} {...rest}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DataTable — string[][] table renderer (first row = header)
// ---------------------------------------------------------------------------

interface DataTableProps {
  data: string[][];
}

export function DataTable({ data }: DataTableProps) {
  if (data.length === 0) return null;
  const [header, ...rows] = data;
  return (
    <table className="w-full border-collapse text-xs">
      <thead>
        <tr>
          {header.map((cell, i) => (
            <th
              key={i}
              className="border-b border-border px-2 py-1.5 text-left font-medium text-muted-foreground"
            >
              {cell}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr
            key={rowIndex}
            className="hover:bg-[var(--surface-hover)] focus-within:bg-[var(--surface-hover)]"
          >
            {row.map((cell, colIndex) => (
              <td
                key={colIndex}
                tabIndex={0}
                className="border-b border-border/45 px-2 py-1.5 tabular-nums focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
