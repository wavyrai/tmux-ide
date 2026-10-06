import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PERSONALITIES, scriptToSvg } from "matinee";

const frames = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../components/marketing/tui-mini-figure-frames.json"),
    "utf8",
  ),
);
const width = frames.width;
const height = frames.height;
const outputDirectory = resolve(import.meta.dirname, "../public/mockup-motion");

/**
 * Cursor choreography for the small TUI figures on the landing page. The
 * figures are crops of the real app (rendered by `pnpm demo:tui`, which also
 * records where each action happens); Matinee contributes a transparent,
 * self-contained performance layer with no client-side runtime.
 */
const performances = Object.fromEntries(
  Object.entries(frames.figures).map(([variant, figure]) => [variant, figure.cursor]),
);

function createSteps(actions) {
  let at = 200;
  const steps = [];

  for (const [action, x, y] of actions) {
    const duration = action === "move" ? 500 : 650;
    steps.push({ action, point: { x, y }, at, duration });
    at += duration + 200;
  }

  // Matinee adds a 700ms tail. Ending at 3300ms gives every performance the
  // same four-second clock, which lets CSS queue cards without cursor drift.
  steps.push({ action: "pause", at, duration: Math.max(0, 3300 - at) });
  return steps;
}

mkdirSync(outputDirectory, { recursive: true });
// Retired figures must not linger as orphaned public assets.
for (const file of readdirSync(outputDirectory))
  if (!(file.replace(/\.svg$/u, "") in performances)) rmSync(resolve(outputDirectory, file));

for (const [variant, actions] of Object.entries(performances)) {
  const svg = scriptToSvg(
    {
      version: 1,
      viewport: { w: width, h: height },
      seed: 2900 + variant.length * 131,
      origin: { x: width - 26, y: height - 18 },
      steps: createSteps(actions),
    },
    {
      background: "transparent",
      color: "#087c9f",
      label: false,
      traits: PERSONALITIES.confident,
      loop: true,
      fps: 24,
    },
  );

  if (/<script/iu.test(svg)) throw new Error(`${variant}: generated SVG contains a script`);
  if (/https?:\/\/(?!www\.w3\.org)/u.test(svg)) {
    throw new Error(`${variant}: generated SVG references an external resource`);
  }

  writeFileSync(resolve(outputDirectory, `${variant}.svg`), svg);
}

console.log(`Matinee: generated ${Object.keys(performances).length} TUI performances`);
