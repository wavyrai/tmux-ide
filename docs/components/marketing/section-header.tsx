import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

type SectionHeaderProps = {
  eyebrow: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  align?: "left" | "center";
  className?: string;
};

/** The one typographic hierarchy used to open every marketing section. */
export function SectionHeader({
  eyebrow,
  title,
  description,
  align = "left",
  className,
}: SectionHeaderProps) {
  return (
    <header className={cn("max-w-2xl", align === "center" && "mx-auto text-center", className)}>
      <div className="type-subheadline text-fd-muted-foreground">{eyebrow}</div>
      <h2
        className={cn(
          "type-display-4 lg:type-display-3 mt-3 max-w-[20ch] text-fd-foreground",
          align === "center" && "mx-auto",
        )}
      >
        {title}
      </h2>
      {description ? (
        <p
          className={cn(
            "type-marketing-lede mt-5 max-w-[62ch] text-fd-muted-foreground",
            align === "center" && "mx-auto",
          )}
        >
          {description}
        </p>
      ) : null}
    </header>
  );
}
