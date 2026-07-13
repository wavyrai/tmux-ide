import Image from "next/image";
import { cn } from "@/lib/cn";

import iconDark from "@/public/icon-dark.png";
import iconLight from "@/public/icon-light.png";

/**
 * The tmux-ide app icon. Two artworks — the blue-gradient tile for light
 * surfaces, the black tile for dark ones — swapped by the theme class rather
 * than by JS, so there's no flash on first paint.
 */
export function AppIcon({
  size = 32,
  className,
  priority = false,
}: {
  size?: number;
  className?: string;
  priority?: boolean;
}) {
  return (
    <span
      className={cn("relative inline-block shrink-0", className)}
      style={{ width: size, height: size }}
    >
      <Image
        src={iconLight}
        alt=""
        width={size}
        height={size}
        priority={priority}
        className="block dark:hidden"
      />
      <Image
        src={iconDark}
        alt=""
        width={size}
        height={size}
        priority={priority}
        className="hidden dark:block"
      />
    </span>
  );
}
