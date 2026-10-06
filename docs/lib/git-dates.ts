import dates from "@/.source/git-dates.json";

/**
 * Source-backed modification dates for sitemap `<lastmod>` and `dateModified`,
 * generated at build time by scripts/generate-git-dates.mjs (see there for how
 * dates are chosen). Undefined means the history cannot back a date.
 */

const pages: Record<string, string | undefined> = dates.pages;

function toDate(iso: string | null | undefined): Date | undefined {
  return iso ? new Date(iso) : undefined;
}

/** Last commit date of a docs page, by its path inside content/docs. */
export function docLastModified(pagePath: string): Date | undefined {
  return toDate(pages[pagePath]);
}

/** Last commit date of the sources that render the marketing homepage. */
export function homeLastModified(): Date | undefined {
  return toDate(dates.home);
}
