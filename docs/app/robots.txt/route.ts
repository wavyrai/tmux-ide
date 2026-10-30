import { SITE_URL } from "@/lib/site";
import { SCHEMA_MAP_PATH } from "@/lib/structured-data";

export const revalidate = false;

const NON_INDEXABLE = ["/api/", "/llms.mdx/"];

/**
 * Hand-written because Next's robots metadata has no field for Content-Signal.
 * The owner's policy: search, AI answers and AI training are all welcome (a
 * stated preference; robots.txt is not access control). Every crawler,
 * including AI crawlers, gets the same `*` group.
 */
const robots = [
  "User-Agent: *",
  "Content-Signal: search=yes, ai-input=yes, ai-train=yes",
  "Allow: /",
  ...NON_INDEXABLE.map((path) => `Disallow: ${path}`),
  "",
  `Host: ${SITE_URL}`,
  `Sitemap: ${SITE_URL}/sitemap.xml`,
  // NLWeb Schema Feeds 0.1 §3: the spec spells the directive in lowercase.
  `schemamap: ${SITE_URL}${SCHEMA_MAP_PATH}`,
  "",
].join("\n");

export function GET() {
  return new Response(robots, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
