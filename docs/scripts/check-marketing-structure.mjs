import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const page = readFileSync(resolve(root, "app/(home)/page.tsx"), "utf8");
const logo = readFileSync(resolve(root, "components/ascii-wordmark.tsx"), "utf8");
const sectionHeader = readFileSync(
  resolve(root, "components/marketing/section-header.tsx"),
  "utf8",
);
const lattice = readFileSync(resolve(root, "components/marketing/lattice.tsx"), "utf8");
const globalCss = readFileSync(resolve(root, "app/global.css"), "utf8");
const footer = readFileSync(resolve(root, "components/site-footer.tsx"), "utf8");
const banner = readFileSync(resolve(root, "components/top-banner.tsx"), "utf8");
const landingContent = readFileSync(resolve(root, "lib/landing-content.ts"), "utf8");
const tuiFigure = readFileSync(resolve(root, "components/marketing/tui-mini-figure.tsx"), "utf8");
const technicalCaption = readFileSync(
  resolve(root, "components/marketing/technical-caption.tsx"),
  "utf8",
);

const failures = [];
const expectAbsent = (source, pattern, message) => {
  if (pattern.test(source)) failures.push(message);
};

expectAbsent(
  page,
  /\buppercase\b/u,
  "uppercase must be scoped through the shared marketing-flag role",
);
expectAbsent(
  page,
  /<MarketingGrid[^>]*className=["'][^"']*gap-px/u,
  "one-pixel separator grids must use Mosaic, not MarketingGrid",
);

if (!/\.marketing-flag\s*\{[^}]*text-transform:\s*uppercase;/su.test(globalCss)) {
  failures.push("marketing flags must resolve uppercase through their shared role");
}

if (
  !/bleed\s*\?\s*["'][^"']*-mx-6[^"']*border-y[^"']*xl:-mx-10[^"']*["']\s*:\s*["']border["']/u.test(
    lattice,
  )
) {
  failures.push("mosaics must close embedded edges while leaving bleeding side rules to the frame");
}

const bleedingMosaicCount = page.match(/<Mosaic\s+bleed\b/gu)?.length ?? 0;
if (bleedingMosaicCount < 2) {
  failures.push("primary page mosaics must terminate on the frame rules");
}
expectAbsent(
  page,
  /const\s+(sectionLabel|displayHeading)\b/u,
  "section typography must come from SectionHeader",
);
expectAbsent(
  page,
  /(?:bg|text|border)-\[#[0-9a-f]{3,8}\]/iu,
  "landing-page colors must resolve through semantic design tokens",
);
expectAbsent(logo, /^["']use client["'];/mu, "the static ASCII logo must remain server-rendered");
expectAbsent(
  `${page}\n${sectionHeader}\n${footer}`,
  /\btext-\[(?:\d|clamp\()/u,
  "landing typography must use semantic type roles, not local numeric sizes",
);
expectAbsent(
  `${page}\n${sectionHeader}\n${footer}\n${banner}`,
  /\b(?:font-(?:medium|semibold|bold)|lowercase)\b/u,
  "marketing typography must stay light, with mono flags resolved uppercase by their shared role",
);

const stretchCount = page.match(/<Stretch\b/gu)?.length ?? 0;
if (stretchCount > 4) {
  failures.push(`ground tones must hold in stretches (found ${stretchCount}, expected at most 4)`);
}

const customBandBodyCount = page.match(/<BandBody\s+className=/gu)?.length ?? 0;
if (customBandBodyCount > 3) {
  failures.push(
    `standard bands must use the shared rhythm (found ${customBandBodyCount} spacing overrides, expected at most 3)`,
  );
}

const expectedFigureNumbers = [
  "02.1",
  "02.2",
  "02.3",
  "03.1",
  "03.2",
  "03.3",
  "04.1",
  "04.2",
  "04.3",
];
const modeledFigureNumbers = [...landingContent.matchAll(/number:\s*"([0-9.]+)"/gu)]
  .map((match) => match[1])
  .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
if (JSON.stringify(modeledFigureNumbers) !== JSON.stringify(expectedFigureNumbers)) {
  failures.push("landing figures must keep the stable 02.1–04.3 technical sequence");
}
if (!tuiFigure.includes("<figure") || !tuiFigure.includes("<TechnicalCaption")) {
  failures.push("TUI diagrams must render as semantic figures through TechnicalCaption");
}
if (!technicalCaption.includes("Fig. {number}.")) {
  failures.push("technical captions must share the canonical figure label");
}
if (!technicalCaption.includes("marketing-type-micro")) {
  failures.push("technical captions must use a merge-safe type role");
}
expectAbsent(
  `${page}\n${sectionHeader}\n${footer}\n${banner}\n${technicalCaption}`,
  /\btext-marketing-(?:title|subtitle|body|caption|micro)\b/u,
  "marketing type roles must not use Tailwind's ambiguous text-* namespace",
);

if (failures.length > 0) {
  console.error(`Marketing structure check failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}

console.log(
  `Marketing structure verified: ${stretchCount} ground stretches, ${customBandBodyCount} intentional spacing exceptions, stable technical figures, role-based typography, semantic colors, and server-rendered branding.`,
);
