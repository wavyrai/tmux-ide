import type { InferPageType } from "fumadocs-core/source";
import { docLastModified, docPublished, homeLastModified } from "@/lib/git-dates";
import { getPageImage, source } from "@/lib/source";
import {
  CURRENT_RELEASE_PATH,
  PUBLISHER_ID,
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_REPOSITORY,
  SITE_URL,
  SOFTWARE_DOWNLOAD_URL,
  SOFTWARE_LICENSE,
  SOFTWARE_VERSION,
  absoluteUrl,
} from "@/lib/site";

type DocsPage = InferPageType<typeof source>;

/** The homepage's SoftwareApplication node: the layout's JSON-LD and the schema feed share it. */
export function softwareApplicationJsonLd() {
  return {
    "@type": "SoftwareApplication",
    "@id": `${SITE_URL}/#software`,
    name: SITE_NAME,
    url: absoluteUrl("/"),
    description: SITE_DESCRIPTION,
    disambiguatingDescription: "tmux-ide, an open-source Prototyper project",
    applicationCategory: "DeveloperApplication",
    applicationSubCategory: "Agent workspace for tmux",
    operatingSystem: "macOS, Linux",
    softwareRequirements: "tmux 3.7 or newer (the installer bundles it)",
    softwareVersion: SOFTWARE_VERSION,
    releaseNotes: absoluteUrl(CURRENT_RELEASE_PATH),
    license: SOFTWARE_LICENSE,
    downloadUrl: SOFTWARE_DOWNLOAD_URL,
    installUrl: absoluteUrl("/docs/getting-started"),
    sameAs: [SITE_REPOSITORY, SOFTWARE_DOWNLOAD_URL],
    author: { "@id": PUBLISHER_ID },
    publisher: { "@id": PUBLISHER_ID },
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  };
}

/** A docs page's TechArticle node: the page's JSON-LD and the schema feed share it. */
export function docArticleJsonLd(page: DocsPage) {
  const pageUrl = absoluteUrl(page.url);
  const modified = docLastModified(page.path);
  const published = docPublished(page.path);
  return {
    "@type": "TechArticle",
    "@id": `${pageUrl}#article`,
    headline: page.data.title,
    description: page.data.description ?? SITE_DESCRIPTION,
    url: pageUrl,
    mainEntityOfPage: pageUrl,
    image: absoluteUrl(getPageImage(page).url),
    ...(published ? { datePublished: published.toISOString() } : {}),
    ...(modified ? { dateModified: modified.toISOString() } : {}),
    inLanguage: "en",
    isPartOf: { "@id": `${SITE_URL}/#website` },
    about: { "@id": `${SITE_URL}/#software` },
    author: { "@id": PUBLISHER_ID },
    publisher: { "@id": PUBLISHER_ID },
  };
}

export const SCHEMA_MAP_PATH = "/schemamap.xml";
export const DOCS_FEED_PATH = "/feeds/docs.jsonl";
/** NLWeb Schema Feeds 0.1, Appendix B: the MIME type for a `structuredData/schema.org` feed. */
export const JSONL_TYPE = "application/x-jsonlines";

/** The docs pages the sitemap lists: noindex pages stay out of the feed too. */
function indexablePages(): DocsPage[] {
  return source.getPages().filter((page) => !page.data.noindex);
}

/**
 * The docs schema feed (NLWeb Schema Feeds 0.1, §5.1): one schema.org object
 * per line, the homepage's SoftwareApplication first, then one TechArticle per
 * indexable docs page, each the node that page's own JSON-LD carries.
 */
export function docsSchemaFeed(): string {
  const nodes = [softwareApplicationJsonLd(), ...indexablePages().map(docArticleJsonLd)];
  return nodes
    .map((node) => JSON.stringify({ "@context": "https://schema.org", ...node }))
    .join("\n")
    .concat("\n");
}

/** Newest source date behind the feed, or undefined when git history can't back one. */
function feedLastModified(): Date | undefined {
  const dates = [homeLastModified(), ...indexablePages().map((page) => docLastModified(page.path))];
  const times = dates.flatMap((date) => (date ? [date.getTime()] : []));
  return times.length ? new Date(Math.max(...times)) : undefined;
}

/** The Schema Map (NLWeb Schema Feeds 0.1, §4): a sitemap-format list of the site's feeds. */
export function schemaMap(): string {
  const lastModified = feedLastModified();
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
    '        xmlns:sf="http://schema.org/schemas/schemafeed/0.1">',
    "  <url>",
    `    <loc>${absoluteUrl(DOCS_FEED_PATH)}</loc>`,
    ...(lastModified ? [`    <lastmod>${lastModified.toISOString()}</lastmod>`] : []),
    "    <sf:contentType>structuredData/schema.org</sf:contentType>",
    "  </url>",
    "</urlset>",
    "",
  ].join("\n");
}
