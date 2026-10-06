import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Which source files date each sitemap URL. Shared by generate-git-dates.mjs
// (which writes the dates) and check-seo.mjs (which re-derives and compares).

export const docsDir = resolve(import.meta.dirname, "..");
export const contentDir = "content/docs";
/** Sources that render the marketing homepage. */
export const homeSources = ["app/(home)", "lib/landing-content.ts", "components/marketing"];

/** Source paths (relative to docs/) for a site pathname, or null when unknown. */
export function sourcesForPath(pathname) {
  if (pathname === "/") return homeSources;
  const match = /^\/docs(?:\/(.+))?$/u.exec(pathname);
  if (!match) return null;
  const slug = match[1];
  const candidates = slug
    ? [`${slug}.mdx`, `${slug}.md`, `${slug}/index.mdx`, `${slug}/index.md`]
    : ["index.mdx", "index.md"];
  const file = candidates.find((candidate) => existsSync(resolve(docsDir, contentDir, candidate)));
  return file ? [`${contentDir}/${file}`] : null;
}
