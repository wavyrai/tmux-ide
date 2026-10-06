import { SITE_URL } from "@/lib/site";

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
  "",
].join("\n");

export function GET() {
  return new Response(robots, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
