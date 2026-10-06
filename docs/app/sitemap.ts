import type { MetadataRoute } from "next";
import { docLastModified, homeLastModified } from "@/lib/git-dates";
import { source } from "@/lib/source";
import { absoluteUrl } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  // noindex pages stay reachable but are not advertised to search engines.
  const docs = source
    .getPages()
    .filter((page) => !page.data.noindex)
    .map((page) => ({
      url: absoluteUrl(page.url),
      lastModified: docLastModified(page.path),
      changeFrequency: "weekly" as const,
      priority: page.url === "/docs" ? 0.9 : 0.7,
    }));

  const routes: MetadataRoute.Sitemap = [
    {
      url: absoluteUrl("/"),
      lastModified: homeLastModified(),
      changeFrequency: "weekly",
      priority: 1,
    },
    ...docs,
  ];

  return routes.filter(
    (route, index) => routes.findIndex((candidate) => candidate.url === route.url) === index,
  );
}
