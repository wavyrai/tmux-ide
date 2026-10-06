import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import { metaSchema, pageSchema } from "fumadocs-core/source/schema";

// You can customise Zod schemas for frontmatter and `meta.json` here
// see https://fumadocs.dev/docs/mdx/collections
export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    schema: pageSchema.extend({
      // SEO-only additions. Built from pageSchema's own Zod types so the docs
      // package needs no direct zod dependency.
      /** Optional <title>/Open Graph/Twitter title; `title` stays the H1 and sidebar label. */
      metaTitle: pageSchema.shape.title.optional(),
      /** Keep the page reachable but out of search results and the sitemap. */
      noindex: pageSchema.shape.full,
    }),
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    schema: metaSchema,
  },
});

export default defineConfig({
  mdxOptions: {
    rehypeCodeOptions: {
      // Every token in these themes meets WCAG AA (4.5:1) on the docs
      // code-block grounds in both schemes; the older github-light/dark
      // pair had comments and an orange token below it.
      themes: { light: "github-light-default", dark: "github-dark-default" },
    },
  },
});
