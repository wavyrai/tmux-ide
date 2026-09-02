import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

const NON_INDEXABLE = ["/api/", "/llms.mdx/"];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: NON_INDEXABLE,
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
