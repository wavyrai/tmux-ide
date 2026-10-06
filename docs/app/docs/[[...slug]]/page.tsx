import { getPageImage, source } from "@/lib/source";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/layouts/docs/page";
import { notFound } from "next/navigation";
import { getMDXComponents } from "@/mdx-components";
import type { Metadata } from "next";
import { createRelativeLink } from "fumadocs-ui/mdx";
import { PageActions, RailActions } from "@/components/docs/page-actions";
import { gitConfig } from "@/lib/layout.shared";
import { docLastModified } from "@/lib/git-dates";
import { PUBLISHER_ID, SITE_DESCRIPTION, SITE_URL, absoluteUrl } from "@/lib/site";

// The docs index's frontmatter title is the bare product name; give the
// document a distinct title instead of "tmux-ide | tmux-ide".
const DOCS_INDEX_TITLE = "tmux-ide documentation";

export default async function Page(props: { params: Promise<{ slug?: string[] }> }) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const description = page.data.description ?? SITE_DESCRIPTION;
  const pageUrl = absoluteUrl(page.url);
  const modified = docLastModified(page.path);
  const breadcrumbs = [
    { "@type": "ListItem", position: 1, name: "Home", item: absoluteUrl("/") },
    {
      "@type": "ListItem",
      position: 2,
      name: "Documentation",
      item: absoluteUrl("/docs"),
    },
    ...(page.url === "/docs"
      ? []
      : [{ "@type": "ListItem", position: 3, name: page.data.title, item: pageUrl }]),
  ];
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "TechArticle",
        "@id": `${pageUrl}#article`,
        headline: page.data.title,
        description,
        url: pageUrl,
        mainEntityOfPage: pageUrl,
        image: absoluteUrl(getPageImage(page).url),
        ...(modified ? { dateModified: modified.toISOString() } : {}),
        inLanguage: "en",
        isPartOf: { "@id": `${SITE_URL}/#website` },
        about: { "@id": `${SITE_URL}/#software` },
        author: { "@id": PUBLISHER_ID },
        publisher: { "@id": PUBLISHER_ID },
      },
      {
        "@type": "BreadcrumbList",
        "@id": `${pageUrl}#breadcrumbs`,
        itemListElement: breadcrumbs,
      },
    ],
  };

  const actions = {
    pageUrl,
    markdownUrl: `${page.url}.mdx`,
    sourceUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}/blob/${gitConfig.branch}/docs/content/docs/${page.path}`,
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</gu, "\\u003c") }}
      />
      <DocsPage
        id="main-content"
        tabIndex={-1}
        toc={page.data.toc}
        full={page.data.full}
        tableOfContent={{ footer: <RailActions {...actions} /> }}
        className="docs-article"
      >
        {/* First child of the article, so it sits above the title on every page. */}
        {/* The table-of-contents rail carries the page actions from xl up;
            this compact row stands in when the rail is hidden (narrow
            screens, full-width pages). */}
        <PageActions {...actions} className={page.data.full ? "" : "xl:hidden"} />
        <DocsTitle className="docs-title">{page.data.title}</DocsTitle>
        <DocsDescription className="docs-description mb-0">{description}</DocsDescription>
        <hr className="border-fd-border" />
        <DocsBody className="docs-prose">
          <MDX
            components={getMDXComponents({
              // this allows you to link to other pages with relative file paths
              a: createRelativeLink(source, page),
            })}
          />
        </DocsBody>
      </DocsPage>
    </>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: {
  params: Promise<{ slug?: string[] }>;
}): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const modified = docLastModified(page.path);
  // `metaTitle` carries the search wording; `title` stays the short H1/sidebar label.
  const metaTitle = page.data.metaTitle ?? page.data.title;
  const noindex = { index: false, follow: true };

  return {
    title:
      page.data.metaTitle ??
      (page.url === "/docs" ? { absolute: DOCS_INDEX_TITLE } : page.data.title),
    description: page.data.description,
    ...(page.data.noindex ? { robots: { ...noindex, googleBot: noindex } } : {}),
    alternates: {
      canonical: page.url,
      types: { "text/markdown": `${page.url}.mdx` },
    },
    openGraph: {
      type: "article",
      url: absoluteUrl(page.url),
      ...(modified ? { modifiedTime: modified.toISOString() } : {}),
      title: metaTitle,
      description: page.data.description,
      images: [
        {
          url: getPageImage(page).url,
          width: 1200,
          height: 630,
          alt: `${page.data.title} — tmux-ide documentation`,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      creator: "@prototyper_co",
      site: "@prototyper_co",
      title: metaTitle,
      description: page.data.description,
      images: [getPageImage(page).url],
    },
  };
}
