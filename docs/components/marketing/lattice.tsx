import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

export type MarketingGround = "paper" | "raise" | "panel";

const groundClasses: Record<MarketingGround, string> = {
  paper: "bg-marketing-paper",
  raise: "bg-marketing-raise",
  panel: "bg-marketing-panel",
};

type LatticeProps = {
  className?: string;
  children: ReactNode;
};

/** One spacing rhythm for every standard marketing band. */
export const BAND_PAD = "px-6 pb-16 pt-20 lg:pb-20 lg:pt-28 xl:px-10";

/** The only placement grid used by marketing sections. */
export const MARKETING_GRID = "grid grid-cols-1 gap-x-6 gap-y-10 lg:grid-cols-24";

/** The page-length 1280px frame. Its two vertical rules anchor every band. */
export function MarketingFrame({
  id,
  tabIndex,
  className,
  children,
}: LatticeProps & { id?: string; tabIndex?: number }) {
  return (
    <div
      id={id}
      tabIndex={tabIndex}
      data-slot="marketing-frame"
      className={cn(
        "font-marketing mx-auto w-full max-w-[1280px] border-x border-marketing-line max-lg:border-x-0",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * A full-bleed run of bands sharing one semantic ground. The foreground
 * overlay re-paints the frame's two vertical rules on the exact same pixels;
 * it never introduces a second, adjacent edge when the bleed crosses them.
 */
export function Stretch({
  ground,
  className,
  children,
}: LatticeProps & { ground: MarketingGround }) {
  return (
    <div
      data-slot="marketing-stretch"
      className={cn(
        "relative isolate before:pointer-events-none before:absolute before:inset-y-0 before:left-[calc(50%-50vw)] before:right-[calc(50%-50vw)] before:-z-10 before:bg-inherit",
        "after:pointer-events-none after:absolute after:inset-y-0 after:-inset-x-px after:z-10 after:border-x after:border-marketing-line after:max-lg:border-x-0",
        groundClasses[ground],
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * One horizontal chapter in the lattice.
 *
 * The band owns its lower seam. Disable that seam when the next surface
 * already owns the boundary (for example, the footer's top rule). Children
 * must not paint the same outer edge; their borders are internal dividers.
 */
export function Band({ rule = true, className, children }: LatticeProps & { rule?: boolean }) {
  return (
    <section
      data-slot="marketing-band"
      className={cn(rule && "border-b border-marketing-line", className)}
    >
      {children}
    </section>
  );
}

/** Shared gutters and vertical rhythm for prose inside an edge-to-edge band. */
export function BandBody({ className, children }: LatticeProps) {
  return (
    <div data-slot="marketing-band-body" className={cn(BAND_PAD, className)}>
      {children}
    </div>
  );
}

/** The 24-column placement grid. Callers place content with col-* classes. */
export function MarketingGrid({ className, children }: LatticeProps) {
  return (
    <div data-slot="marketing-grid" className={cn(MARKETING_GRID, className)}>
      {children}
    </div>
  );
}

/**
 * A peer-dense grid whose line-colored one-pixel gaps own its internal rules.
 * Embedded mosaics also own their complete outer enclosure. Bleeding mosaics
 * leave the side rules to the page frame so those pixels are never doubled.
 */
export function Mosaic({ bleed = false, className, children }: LatticeProps & { bleed?: boolean }) {
  return (
    <div
      data-slot="marketing-mosaic"
      className={cn(
        "grid grid-cols-1 gap-px border-marketing-line bg-marketing-line",
        bleed ? "-mx-6 border-y xl:-mx-10" : "border",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A square-to-the-rules mosaic tile; density and placement stay at the call site. */
export function Cell({ ground, className, children }: LatticeProps & { ground?: MarketingGround }) {
  return (
    <div
      data-slot="marketing-cell"
      className={cn("relative overflow-hidden", ground && groundClasses[ground], className)}
    >
      {children}
    </div>
  );
}
