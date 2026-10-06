import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The site's text faces for the social-card renderer, which bundles only Geist
 * and Geist Mono. Latin subsets of Inter 400 and Plus Jakarta Sans 600 (both
 * SIL OFL 1.1; licences beside the files in assets/fonts/og/), read once at
 * module load and reused by every card. Pass loadDefaultFonts: true alongside
 * them so the bundled Geist Mono (monospace) and Geist (symbol fallback) stay.
 */
const dir = join(process.cwd(), "assets", "fonts", "og");

export const OG_FONTS = [
  { name: "Inter", data: readFileSync(join(dir, "inter-latin-400.woff2")), weight: 400 },
  {
    name: "Plus Jakarta Sans",
    data: readFileSync(join(dir, "plus-jakarta-sans-latin-600.woff2")),
    weight: 600,
  },
];
