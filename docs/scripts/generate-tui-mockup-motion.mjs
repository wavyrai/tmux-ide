import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PERSONALITIES, scriptToSvg } from "matinee";

const width = 360;
const height = 140;
const outputDirectory = resolve(import.meta.dirname, "../public/mockup-motion");

/**
 * Cursor choreography for the small TUI figures on the landing page. The
 * underlying interface remains a theme-aware React SVG; Matinee contributes a
 * transparent, self-contained performance layer with no client-side runtime.
 */
const performances = {
  names: [
    ["click", 65, 50],
    ["click", 198, 47],
  ],
  status: [
    ["click", 281, 42],
    ["click", 281, 86],
  ],
  navigate: [
    ["click", 66, 50],
    ["click", 319, 101],
  ],
  window: [["click", 326, 48]],
  split: [
    ["click", 98, 82],
    ["click", 270, 82],
  ],
  resize: [
    ["click", 198, 92],
    ["move", 220, 92],
  ],
  rename: [
    ["click", 42, 79],
    ["click", 187, 79],
  ],
  focus: [
    ["click", 92, 83],
    ["click", 272, 83],
  ],
  close: [
    ["click", 322, 46],
    ["click", 177, 97],
  ],
  tmux: [
    ["click", 79, 90],
    ["click", 186, 90],
    ["click", 293, 90],
  ],
  daemon: [
    ["move", 72, 75],
    ["click", 180, 75],
    ["move", 295, 75],
  ],
  opentui: [
    ["click", 57, 58],
    ["click", 168, 82],
    ["click", 280, 82],
  ],
};

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

for (const [variant, actions] of Object.entries(performances)) {
  const svg = scriptToSvg(
    {
      version: 1,
      viewport: { w: width, h: height },
      seed: 2900 + variant.length * 131,
      origin: { x: 334, y: 122 },
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
