import Image from "next/image";

import { cn } from "@/lib/cn";

const sizeClasses = {
  hero: "h-auto w-full max-w-[630px]",
  nav: "h-auto w-[62px] sm:w-[68px]",
  footer: "h-auto w-[105px] sm:w-[115px]",
} as const;

export function AsciiWordmark({
  size = "hero",
  animated = false,
  inverted = false,
  className,
}: {
  size?: keyof typeof sizeClasses;
  animated?: boolean;
  inverted?: boolean;
  className?: string;
}) {
  return (
    <Image
      src="/ascii-wordmark.svg"
      alt="tmux-ide"
      width={630}
      height={126}
      unoptimized
      className={cn(
        "block shrink-0 select-none dark:invert",
        animated && "marketing-enter",
        inverted && "invert",
        sizeClasses[size],
        className,
      )}
    />
  );
}
