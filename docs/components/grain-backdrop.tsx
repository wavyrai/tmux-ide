"use client";

import { GrainGradient } from "@paper-design/shaders-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

/**
 * The Grain backdrop — the shader and uniforms from the Prototyper asset
 * studio's grain presets (apps/web/app/dev/asset-studio/backdrops.tsx), ported
 * rather than eyeballed so the two surfaces stay in one family.
 *
 * TONES: the studio ships teal (day/night), indigo, and ember; the mesh presets
 * supply the violet and sky accents. Each stage on the page takes a different
 * tone so the chapters don't read as one long wash — the accent moves through
 * the page while the ground stays the same material.
 *
 * The dark variants are the studio's own values. The light variants are derived
 * on the studio's day structure (near-white body, paper back) with the tone's
 * accent swapped in — the studio only ships a teal day, so anything else would
 * have to be invented; this keeps the invention to one axis.
 *
 * `speed: 0, frame: 0` keeps every stage STILL — a ground for a terminal, not an
 * animation competing with it.
 *
 * ONE canvas per stage: each GrainGradient is a live WebGL context and browsers
 * cap them (~16, silently dropping the oldest), so mounting both themes per
 * stage — five stages, ten contexts — would be a latent bug. We resolve the
 * theme first and mount only the variant in use.
 */

const STILL = { speed: 0, frame: 0 } as const;
const FILL = { width: "100%", height: "100%" } as const;

interface Preset {
  colors: readonly [string, string, string];
  colorBack: string;
  softness: number;
  intensity: number;
  shape: "wave" | "dots";
}

export type GrainTone = "teal" | "indigo" | "violet" | "ember" | "sky";

const NIGHT: Record<GrainTone, Preset> = {
  // The studio's "Grain — night", verbatim.
  teal: {
    colors: ["#000000", "#0d0d0d", "#57a6a8"],
    colorBack: "#000a0f",
    softness: 0.7,
    intensity: 0.15,
    shape: "wave",
  },
  // The studio's "Grain — indigo", verbatim.
  indigo: {
    colors: ["#0b0b18", "#1e1b4b", "#6366f1"],
    colorBack: "#05050c",
    softness: 0.7,
    intensity: 0.2,
    shape: "wave",
  },
  // Violet — the mesh-brand accent (#a855f7) on the indigo structure.
  violet: {
    colors: ["#0b0616", "#3b1e5b", "#a855f7"],
    colorBack: "#07040c",
    softness: 0.7,
    intensity: 0.2,
    shape: "wave",
  },
  // The studio's "Grain — ember", verbatim (dots, not wave — its own choice).
  ember: {
    colors: ["#140a04", "#7c2d12", "#f97316"],
    colorBack: "#0a0603",
    softness: 0.65,
    intensity: 0.2,
    shape: "dots",
  },
  // Sky — the mesh-brand accent (#38bdf8) on the teal structure.
  sky: {
    colors: ["#00070f", "#0c2233", "#38bdf8"],
    colorBack: "#00060d",
    softness: 0.7,
    intensity: 0.15,
    shape: "wave",
  },
};

const DAY: Record<GrainTone, Preset> = {
  // The studio's "Grain — day", verbatim.
  teal: {
    colors: ["#ffffff", "#e9edec", "#8fc9ca"],
    colorBack: "#f6f6f4",
    softness: 0.7,
    intensity: 0.15,
    shape: "wave",
  },
  indigo: {
    colors: ["#ffffff", "#eceaf5", "#a5a7e4"],
    colorBack: "#f6f6f8",
    softness: 0.7,
    intensity: 0.15,
    shape: "wave",
  },
  violet: {
    colors: ["#ffffff", "#f0eaf7", "#c39ee2"],
    colorBack: "#f7f5f9",
    softness: 0.7,
    intensity: 0.15,
    shape: "wave",
  },
  ember: {
    colors: ["#ffffff", "#f5ece5", "#eeb086"],
    colorBack: "#f8f6f4",
    softness: 0.65,
    intensity: 0.15,
    shape: "dots",
  },
  sky: {
    colors: ["#ffffff", "#e8eff5", "#93cdee"],
    colorBack: "#f5f7f9",
    softness: 0.7,
    intensity: 0.15,
    shape: "wave",
  },
};

function Grain({ preset }: { preset: Preset }) {
  return (
    <GrainGradient
      colors={[...preset.colors]}
      colorBack={preset.colorBack}
      softness={preset.softness}
      intensity={preset.intensity}
      noise={0.5}
      shape={preset.shape}
      scale={1}
      style={FILL}
      {...STILL}
    />
  );
}

/** A stage: the grain ground, with whatever sits on it floating above. */
export function GrainStage({
  children,
  tone = "teal",
}: {
  children: React.ReactNode;
  tone?: GrainTone;
}) {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const preset = (resolvedTheme === "dark" ? NIGHT : DAY)[tone];

  return (
    <div
      className="relative isolate overflow-hidden border border-fd-border"
      // Paint the ground's own back color before the canvas arrives, so the
      // stage is already the right color on first paint and nothing flashes.
      style={{ background: mounted ? preset.colorBack : DAY[tone].colorBack }}
    >
      {mounted ? (
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
          <Grain preset={preset} />
        </div>
      ) : null}
      <div className="p-6 md:p-10">{children}</div>
    </div>
  );
}
