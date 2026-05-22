"use client";

import { useEffect, useMemo, useRef } from "react";
import { cn } from "../lib/cn";
import {
  BASE,
  BAYER,
  FACES,
  OUTLINE,
  SH,
  SW,
  THEMES,
  type DotAvatarFace,
  type DotAvatarTheme,
} from "./dot-avatar-data";

function buildSprite(face: DotAvatarFace): number[][] {
  const grid = BASE.map((row) => [...row]);
  for (const [r, c] of FACES[face]) {
    if (r >= 0 && r < SH && c >= 0 && c < SW) grid[r][c] = 4;
  }
  return grid;
}

export interface DotAvatarProps {
  face?: DotAvatarFace;
  theme?: DotAvatarTheme;
  /** Rendered avatar size in CSS pixels. Defaults to 48. */
  size?: number;
  /** Soft glow halo behind the sprite. */
  glow?: boolean;
  className?: string;
  title?: string;
}

export function DotAvatar({
  face = "happy",
  theme = "void",
  size = 48,
  glow = false,
  className,
  title,
}: DotAvatarProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const palette = THEMES[theme];
  const grid = useMemo(() => buildSprite(face), [face]);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = Math.min(typeof window !== "undefined" ? window.devicePixelRatio : 1, 2) || 1;
    cv.width = size * dpr;
    cv.height = size * dpr;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    const cell = size / SW;
    const fcx = SW * 0.5;
    const fcy = SH * 0.28;

    for (let r = 0; r < SH; r++) {
      for (let c = 0; c < SW; c++) {
        const v = grid[r][c];
        if (v === 0) continue;
        let color: string;
        if (v === 1 || v === 4) {
          color = OUTLINE;
        } else {
          const dx = c - fcx;
          const dy = r - fcy;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const value = Math.min(1, dist / (SW * 0.55));
          const threshold = (BAYER[r % 8][c % 8] + 0.5) / 64;
          color = value > threshold ? palette.glow : palette.face;
        }
        ctx.fillStyle = color;
        ctx.fillRect(c * cell, r * cell, cell + 0.5, cell + 0.5);
      }
    }
  }, [grid, palette, size]);

  return (
    <span
      className={cn("inline-block leading-none align-middle", className)}
      style={
        glow
          ? {
              filter: `drop-shadow(0 0 ${size * 0.18}px ${palette.body}66)`,
            }
          : undefined
      }
      title={title}
      aria-label={title ?? `${face} ${theme} dot avatar`}
      role="img"
    >
      <canvas
        ref={ref}
        width={size}
        height={size}
        style={{ width: size, height: size, imageRendering: "pixelated" }}
        className="block"
      />
    </span>
  );
}
