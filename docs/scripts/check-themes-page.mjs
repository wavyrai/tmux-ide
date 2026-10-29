// The /themes gallery (#644), checked on the built site: its search metadata,
// one card per shown preset with alt text naming the theme, an attribution
// line on every preset adapted from a third-party scheme, the presets held
// back from the public page, and the links that lead to it.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SHOWN_PRESETS } from "../components/themes-gallery/shown-presets.mjs";

const docsDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const appDir = resolve(docsDir, ".next/server/app");
const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");
const failures = [];
const fail = (message) => failures.push(message);

// Presets that adapt another project's scheme, with the scheme each must
// credit. Kept here, apart from shown-presets.mjs, so dropping an attribution
// there fails this check instead of silently passing it.
const THIRD_PARTY = {
  "solarized-light": "Solarized",
  "gruvbox-light": "Gruvbox",
  "nord-light": "Nord",
  "github-light": "GitHub",
  tokyo: "Tokyo Night",
  solarized: "Solarized",
  dracula: "Dracula",
  nord: "Nord",
  monokai: "Monokai",
  catppuccin: "Catppuccin",
  gruvbox: "Gruvbox",
  rosepine: "Rosé Pine",
};
// Names not cleared for the public page (card #644, design review item 2).
const HELD_BACK = { monokai: "Monokai", "github-light": "GitHub Light" };

const decode = (text) =>
  text
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");

const html = read(resolve(appDir, "themes.html"));
if (!html) fail("/themes is not a built page (.next/server/app/themes.html)");

const title = decode(html.match(/<title>([^<]*)<\/title>/u)?.[1] ?? "");
if (!title.startsWith("tmux themes") || title.length > 60)
  fail(`/themes <title> must start with "tmux themes" and be at most 60 chars: "${title}"`);
const description = decode(html.match(/<meta name="description" content="([^"]*)"/u)?.[1] ?? "");
if (
  !description ||
  description.length > 155 ||
  !/\blight\b/iu.test(description) ||
  !/\bdark\b/iu.test(description)
)
  fail(`/themes description must be 1–155 chars and name light and dark: "${description}"`);
const h1s = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gu)].map((m) =>
  decode(m[1].replace(/<[^>]+>/gu, "")).trim(),
);
if (h1s.length !== 1 || h1s[0] !== "tmux themes")
  fail(`/themes must have one h1, "tmux themes"; has [${h1s.join(" | ")}]`);
if (!/<link rel="canonical" href="https:\/\/tmux-ide\.com\/themes"\/>/u.test(html))
  fail("/themes must have its own canonical, https://tmux-ide.com/themes");
if (/<meta name="robots" content="noindex/u.test(html)) fail("/themes must be indexable");

const sitemap = read(resolve(appDir, "sitemap.xml.body"));
if (!/<loc>https:\/\/tmux-ide\.com\/themes<\/loc>/u.test(sitemap))
  fail("/themes is not in the sitemap");

// One card per shown preset, each image's alt naming its theme.
const cards = [...html.matchAll(/<article id="([\w-]+)"/gu)].map((m) => m[1]);
const shownIds = SHOWN_PRESETS.map(({ id }) => id);
if (JSON.stringify([...cards].sort()) !== JSON.stringify([...shownIds].sort()))
  fail(`/themes must have one card per shown preset; cards [${cards}], shown [${shownIds}]`);
for (const id of shownIds) {
  const card = html.split(`<article id="${id}"`)[1]?.split("</article>")[0] ?? "";
  const name = decode(card.match(/<h3[^>]*>([^<]+)<\/h3>/u)?.[1] ?? "");
  const alt = decode(card.match(/<img[^>]*\salt="([^"]*)"/u)?.[1] ?? "");
  if (!name || !alt.includes(`${name} theme`))
    fail(`/themes card "${id}" needs an image whose alt names the theme ("${name}"); alt "${alt}"`);
  if (!card.includes(`href="/themes/${id}-full.webp"`))
    fail(`/themes card "${id}" must link its full-size render`);
  const scheme = THIRD_PARTY[id];
  if (scheme) {
    const line = decode(
      (card.match(/<span data-attribution="[^"]*">([\s\S]*?)<\/span>/u)?.[1] ?? "").replace(
        /<[^>]+>|<!-- -->/gu,
        "",
      ),
    );
    if (!line.startsWith(`Palette adapted from ${scheme}, `))
      fail(
        `/themes card "${id}" must say "Palette adapted from ${scheme}, <licence>"; has "${line}"`,
      );
  }
}

// Held-back names stay off the page and out of public/ unless the shown list includes them.
const themesDir = resolve(docsDir, "public/themes");
const published = existsSync(themesDir) ? readdirSync(themesDir) : [];
for (const [id, name] of Object.entries(HELD_BACK)) {
  if (shownIds.includes(id)) continue;
  if (html.includes(name)) fail(`/themes must not name the held-back preset "${name}"`);
  if (published.some((file) => file.startsWith(`${id}.`) || file.startsWith(`${id}-`)))
    fail(`public/themes must not publish a render of the held-back preset "${id}"`);
}

// The links into the gallery.
const theming = read(resolve(appDir, "docs/theming.html"));
if (!/href="\/themes"/u.test(theming)) fail("/docs/theming must link to /themes");
if (!/href="\/docs\/theming"/u.test(html)) fail("/themes must link back to /docs/theming");
const home = read(resolve(appDir, "index.html"));
if (!/<footer[\s\S]*href="\/themes"[\s\S]*<\/footer>/u.test(home))
  fail("the site footer must link to /themes");
const llms = read(resolve(appDir, "llms.txt.body"));
if (!llms.includes("](https://tmux-ide.com/themes)")) fail("llms.txt must link to /themes");

// The design mockup is gone.
if (existsSync(resolve(appDir, "dev")) || existsSync(resolve(docsDir, "app/dev")))
  fail("no /dev route may ship");

if (failures.length > 0) {
  console.error(`Themes page check failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(
  `Themes page verified: metadata, sitemap, ${shownIds.length} cards with alt text and full-size links, ` +
    `${shownIds.filter((id) => THIRD_PARTY[id]).length} third-party attributions, held-back presets absent, ` +
    "links from /docs/theming, the footer and llms.txt.",
);
