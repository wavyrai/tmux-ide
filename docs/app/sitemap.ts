import type { MetadataRoute } from "next";
import { AGENTS_PAGE } from "@/components/agents-page/content";
import { docLastModified, homeLastModified, routeLastModified } from "@/lib/git-dates";
import { source } from "@/lib/source";
import { absoluteUrl } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  // noindex pages stay reachable but are not advertised to search engines.
  // No changefreq/priority: Google ignores both; lastmod is the signal that counts.
  const docs = source
    .getPages()
    .filter((page) => !page.data.noindex)
    .map((page) => ({
      url: absoluteUrl(page.url),
      lastModified: docLastModified(page.path),
    }));

  const routes: MetadataRoute.Sitemap = [
    {
      url: absoluteUrl("/"),
      lastModified: homeLastModified(),
    },
    {
      url: absoluteUrl(AGENTS_PAGE.path),
      lastModified: routeLastModified(AGENTS_PAGE.path),
    },
    ...["/about", "/contact", "/privacy", "/themes"].map((path) => ({
      url: absoluteUrl(path),
      lastModified: routeLastModified(path),
    })),
    ...docs,
  ];

  return routes.filter(
    (route, index) => routes.findIndex((candidate) => candidate.url === route.url) === index,
  );
}
