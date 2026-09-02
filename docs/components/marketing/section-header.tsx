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
      <div className="marketing-flag marketing-type-caption font-mono text-fd-primary">
        {eyebrow}
      </div>
      <h2
        className={cn(
          "marketing-type-title mt-4 max-w-[20ch] text-fd-foreground",
          align === "center" && "mx-auto",
        )}
      >
        {title}
      </h2>
      {description ? (
        <p
          className={cn(
            "marketing-type-body mt-5 max-w-[62ch] text-fd-muted-foreground",
            align === "center" && "mx-auto",
          )}
        >
          {description}
        </p>
      ) : null}
    </header>
  );
}
