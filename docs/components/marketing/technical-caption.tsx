import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * The site's figure caption: a short "Fig N." label in the mono caption
 * role, then the caption text, with no separator rule. Figures are numbered
 * 1, 2, 3 … in reading order on each page.
 */
export function TechnicalCaption({
  number,
  children,
  action,
  ruled = false,
  className,
  id,
}: {
  number: string;
  children: ReactNode;
  action?: ReactNode;
  ruled?: boolean;
  className?: string;
  id?: string;
}) {
  return (
    <figcaption
      id={id}
      className={cn(
        "technical-caption type-caption-1",
        ruled && "border-t border-marketing-line",
        className,
      )}
    >
      <span>
        <span className="mr-2 font-mono">Fig {number}.</span>
        <span className="text-fd-foreground">{children}</span>
      </span>
      {action}
    </figcaption>
  );
}
