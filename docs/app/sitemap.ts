import type { MetadataRoute } from "next";
import { source } from "@/lib/source";
import { SITE_URL } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const docs = source.getPages().map((page) => ({
    url: `${SITE_URL}${page.url}`,
    changeFrequency: "weekly" as const,
    priority: page.url === "/docs" ? 0.9 : 0.7,
  }));

  const routes: MetadataRoute.Sitemap = [
    {
      url: `${SITE_URL}/`,
      changeFrequency: "weekly",
      priority: 1,
    },
    ...docs,
  ];

  return routes.filter(
    (route, index) => routes.findIndex((candidate) => candidate.url === route.url) === index,
  );
}
