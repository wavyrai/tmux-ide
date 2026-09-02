import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const appDir = resolve(root, ".next/server/app");
const homepage = readFileSync(resolve(appDir, "index.html"), "utf8");
const docsPage = readFileSync(resolve(appDir, "docs/getting-started.html"), "utf8");
const layout = readFileSync(resolve(root, "app/layout.tsx"), "utf8");
const home = readFileSync(resolve(root, "app/(home)/page.tsx"), "utf8");
const docs = readFileSync(resolve(root, "app/docs/[[...slug]]/page.tsx"), "utf8");
const wordmark = readFileSync(resolve(root, "components/ascii-wordmark.tsx"), "utf8");
const copyButton = readFileSync(resolve(root, "app/(home)/copy-button.tsx"), "utf8");
const banner = readFileSync(resolve(root, "components/top-banner.tsx"), "utf8");
const css = readFileSync(resolve(root, "app/global.css"), "utf8");

const requiredSource = [
  [layout, 'href="#main-content"', "root layout must provide a skip link"],
  [home, 'id="main-content"', "homepage must expose the skip-link target"],
  [home, "tabIndex={-1}", "homepage skip target must be programmatically focusable"],
  [docs, 'id="main-content"', "docs must expose the skip-link target"],
  [docs, "tabIndex={-1}", "docs skip target must be programmatically focusable"],
  [wordmark, 'alt="tmux-ide"', "ASCII wordmark must have a concise accessible name"],
  [copyButton, 'aria-live="polite"', "copy feedback must be announced"],
  [banner, "Prototyper OSS program (opens in a new tab)", "banner logo needs a useful name"],
  [css, ":focus-visible", "interactive elements need a visible keyboard focus state"],
  [css, "@media (prefers-reduced-motion: reduce)", "motion needs a reduced-motion mode"],
];

for (const [source, marker, message] of requiredSource) {
  if (!source.includes(marker)) throw new Error(message);
}

for (const [name, html] of [
  ["homepage", homepage],
  ["docs", docsPage],
]) {
  if (!html.includes('<html lang="en"')) throw new Error(`${name} is missing a document language`);
  if (!html.includes("Skip to content")) throw new Error(`${name} is missing the skip link`);
  if (!html.includes('id="main-content"')) throw new Error(`${name} is missing the skip target`);
  if (!html.includes("<main")) throw new Error(`${name} is missing its main landmark`);

  const h1Count = html.match(/<h1\b/gu)?.length ?? 0;
  if (h1Count !== 1) throw new Error(`${name} must contain exactly one h1 (found ${h1Count})`);

  const images = html.match(/<img\b[^>]*>/gu) ?? [];
  const missingAlt = images.filter((image) => !/\balt=/u.test(image));
  if (missingAlt.length > 0)
    throw new Error(`${name} contains ${missingAlt.length} images without alt`);

  const ids = [...html.matchAll(/\bid="([^"]+)"/gu)].map((match) => match[1]);
  const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (duplicateIds.length > 0) {
    throw new Error(`${name} contains duplicate ids: ${duplicateIds.join(", ")}`);
  }
}

const figureCount = homepage.match(/<figure\b/gu)?.length ?? 0;
const captionCount = homepage.match(/<figcaption\b/gu)?.length ?? 0;
const labelledFigureCount = homepage.match(/<figure\b[^>]*aria-labelledby=/gu)?.length ?? 0;
if (figureCount !== 10 || captionCount !== figureCount || labelledFigureCount !== figureCount) {
  throw new Error(
    `homepage technical figures must be captioned and labelled (figures ${figureCount}, captions ${captionCount}, labelled ${labelledFigureCount})`,
  );
}

console.log(
  "Accessibility structure verified: language, landmarks, skip targets, headings, labelled figures, alt text, focus, announcements, and reduced motion.",
);
