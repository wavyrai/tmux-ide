import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

export function TechnicalCaption({
  number,
  children,
  action,
  ruled = true,
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
        "marketing-type-micro flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3 font-mono text-fd-muted-foreground",
        ruled && "border-t border-marketing-line",
        className,
      )}
    >
      <span>
        <span className="mr-3 text-fd-foreground">Fig. {number}.</span>
        {children}
      </span>
      {action}
    </figcaption>
  );
}
