import { readdirSync, readFileSync, statSync } from "node:fs";
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
const installTabs = readFileSync(resolve(root, "components/marketing/install-tabs.tsx"), "utf8");
const marketingSources = [page, sectionHeader, footer, banner, technicalCaption, installTabs].join(
  "\n",
);

const failures = [];
const expectAbsent = (source, pattern, message) => {
  if (pattern.test(source)) failures.push(message);
};

// Labels are sentence case. Uppercase eyebrows and flags were retired with
// the role ramp; no marketing source may reintroduce them.
expectAbsent(marketingSources, /\buppercase\b/u, "labels must be sentence case, not uppercase");
expectAbsent(
  `${marketingSources}\n${globalCss}`,
  /\bmarketing-flag\b|text-transform:\s*uppercase/u,
  "the retired uppercase marketing-flag role must not return",
);
expectAbsent(
  page,
  /<MarketingGrid[^>]*className=["'][^"']*gap-px/u,
  "one-pixel separator grids must use Mosaic, not MarketingGrid",
);

for (const role of [
  "type-large-title",
  "type-display-1",
  "type-display-2",
  "type-display-3",
  "type-display-4",
  "type-title-1",
  "type-title-2",
  "type-title-3",
  "type-headline",
  "type-subheadline",
  "type-body",
  "type-body-2",
  "type-caption-1",
  "type-caption-2",
  "type-caption-3",
  "type-marketing-body",
  "type-marketing-lede",
  "type-marketing-subtitle",
  "type-page-title",
  "type-card-title",
  "type-hero-title",
  "type-hero-lede",
]) {
  if (!new RegExp(`@utility ${role} \\{`, "u").test(globalCss)) {
    failures.push(`the type ramp must define ${role}`);
  }
}
if (!/:where\(h1, h2, h3, h4, h5, h6\)\s*\{[^}]*--font-display/su.test(globalCss)) {
  failures.push("every heading must use the display face");
}
// Display and title roles (24px and up) share one measured tracking value;
// smaller roles keep the face's natural spacing.
for (const role of [
  "type-large-title",
  "type-display-1",
  "type-display-2",
  "type-display-3",
  "type-display-4",
  "type-title-1",
  "type-page-title",
]) {
  const body = globalCss.match(new RegExp(`@utility ${role} \\{([^}]*)`, "u"))?.[1] ?? "";
  if (!body.includes("letter-spacing: -0.02em")) {
    failures.push(`${role} must track at -0.02em`);
  }
}

if (
  !/bleed\s*\?\s*["'][^"']*-mx-\[var\(--site-gutter\)\][^"']*border-y[^"']*["']\s*:\s*["']border["']/u.test(
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
  marketingSources,
  /\btext-(?:\[(?:\d|clamp\()|(?:xs|sm|base|lg|xl|[2-9]xl)\b)/u,
  "marketing typography must pick a type role, not a raw or Tailwind size",
);
// Weight is part of each type role (display medium, titles semibold, body
// regular), so call sites never set it directly.
expectAbsent(
  marketingSources,
  /\b(?:font-(?:thin|extralight|light|medium|semibold|bold|extrabold|black)|lowercase)\b/u,
  "font weight must come from the type role, not the call site",
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

// Landing figure numbers in reading order: the agent cards (02.x) and the
// capability cards (05.x); Figs. 03 and 04 are the full-width system figures.
const expectedFigureNumbers = ["02.1", "02.2", "02.3", "05.1", "05.2", "05.3"];
const modeledFigureNumbers = [...landingContent.matchAll(/number:\s*"([0-9.]+)"/gu)]
  .map((match) => match[1])
  .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
if (JSON.stringify(modeledFigureNumbers) !== JSON.stringify(expectedFigureNumbers)) {
  failures.push("landing figures must keep the stable 02.x / 05.x technical sequence");
}
if (!tuiFigure.includes("<figure") || !tuiFigure.includes("<TechnicalCaption")) {
  failures.push("TUI diagrams must render as semantic figures through TechnicalCaption");
}
if (!technicalCaption.includes("Fig. {number}.")) {
  failures.push("technical captions must share the canonical figure label");
}
if (!technicalCaption.includes("type-caption-1")) {
  failures.push("technical captions must use a merge-safe type role");
}
expectAbsent(
  marketingSources,
  /\b(?:text-marketing-[a-z]+|marketing-type-[a-z]+)\b/u,
  "type roles use the type-* namespace (never Tailwind's ambiguous text-*, nor the retired names)",
);

for (const role of [
  "footer-frame",
  "footer-rule-grid",
  "footer-surface",
  "footer-foreground",
  "footer-muted",
  "footer-wordmark",
]) {
  if (!footer.includes(role) || !globalCss.includes(`.${role}`)) {
    failures.push(`the production-stable dark footer must define and consume ${role}`);
  }
}
expectAbsent(
  footer,
  /\b(?:bg-marketing-(?:paper|line)|text-fd-(?:foreground|muted-foreground))\b/u,
  "the permanent dark footer must not depend on page-theme utility inheritance",
);

// Corners are square or fully rounded, nothing in between. Site code may
// use rounded-full / rounded-none only; CSS radii must be 0, a pill
// (9999px or --radius-pill) or inherit; every theme radius step is 0.
const siteFiles = [];
const collectSite = (directory) => {
  for (const entry of readdirSync(directory)) {
    const path = resolve(directory, entry);
    if (statSync(path).isDirectory()) collectSite(path);
    else if (/\.(tsx?|css)$/u.test(entry)) siteFiles.push(path);
  }
};
for (const directory of ["app", "components", "lib"]) collectSite(resolve(root, directory));
for (const path of siteFiles) {
  const source = readFileSync(path, "utf8");
  const name = path.replace(`${root}/`, "");
  const steppedClass =
    source.match(
      /(?<![\w-])rounded-(?:(?:t|r|b|l|s|e|tl|tr|bl|br|ss|se|es|ee)-)?(?!full\b|none\b)[\w[\]().%-]+/u,
    ) ?? source.match(/class(?:Name)?=["'{`][^"'`]*(?<![\w-])rounded(?![\w-])/u);
  if (steppedClass)
    failures.push(`${name}: corners must be square or pill, found "${steppedClass[0]}"`);
  for (const match of source.matchAll(
    /border(?:-[a-z]+)?-radius:\s*([^;]+);|borderRadius:\s*["'`]?([^,"'`}]+)/gu,
  )) {
    const value = (match[1] ?? match[2]).trim();
    if (!/^(?:0|0px|9999px|var\(--radius-pill\)|inherit)(?:\s*!important)?$/u.test(value)) {
      failures.push(`${name}: border radius must be 0 or a pill, found "${value}"`);
    }
  }
}
for (const match of globalCss.matchAll(/--radius-([\w-]+):\s*([^;]+);/gu)) {
  const ok = match[1] === "pill" ? match[2].trim() === "9999px" : match[2].trim() === "0";
  if (!ok) failures.push(`radius token --radius-${match[1]} must be 0 (or 9999px for the pill)`);
}

if (failures.length > 0) {
  console.error(`Marketing structure check failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}

console.log(
  `Marketing structure verified: ${stretchCount} ground stretches, ${customBandBodyCount} intentional spacing exceptions, stable technical figures, the role-based type ramp, square-or-pill corners, semantic colors, and server-rendered branding.`,
);
