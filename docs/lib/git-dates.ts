import dates from "@/.source/git-dates.json";

/**
 * Source-backed modification dates for sitemap `<lastmod>` and `dateModified`,
 * generated at build time by scripts/generate-git-dates.mjs (see there for how
 * dates are chosen). Undefined means the history cannot back a date.
 */

const pages: Record<string, string | undefined> = dates.pages;
const published: Record<string, string | undefined> = dates.published;

function toDate(iso: string | null | undefined): Date | undefined {
  return iso ? new Date(iso) : undefined;
}

/** Last commit date of a docs page, by its path inside content/docs. */
export function docLastModified(pagePath: string): Date | undefined {
  return toDate(pages[pagePath]);
}

/** Date the docs page was first committed, by its path inside content/docs. */
export function docPublished(pagePath: string): Date | undefined {
  return toDate(published[pagePath]);
}

/** Last commit date of the sources that render the marketing homepage. */
export function homeLastModified(): Date | undefined {
  return toDate(dates.home);
}
