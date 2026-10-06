import { getPageImage, source } from "@/lib/source";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/layouts/docs/page";
import { notFound } from "next/navigation";
import { getMDXComponents } from "@/mdx-components";
import type { Metadata } from "next";
import { createRelativeLink } from "fumadocs-ui/mdx";
import { PageActions } from "@/components/docs/page-actions";
import { gitConfig } from "@/lib/layout.shared";
import { SITE_DESCRIPTION, SITE_URL, absoluteUrl } from "@/lib/site";

export default async function Page(props: { params: Promise<{ slug?: string[] }> }) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const description = page.data.description ?? SITE_DESCRIPTION;
  const pageUrl = absoluteUrl(page.url);
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
        inLanguage: "en",
        isPartOf: { "@id": `${SITE_URL}/#website` },
        publisher: { "@id": `${SITE_URL}/#organization` },
      },
      {
        "@type": "BreadcrumbList",
        "@id": `${pageUrl}#breadcrumbs`,
        itemListElement: breadcrumbs,
      },
    ],
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
        className="docs-article"
      >
        {/* First child of the article, so it sits above the title on every page. */}
        <PageActions
          pageUrl={pageUrl}
          markdownUrl={`${page.url}.mdx`}
          sourceUrl={`https://github.com/${gitConfig.user}/${gitConfig.repo}/blob/${gitConfig.branch}/docs/content/docs/${page.path}`}
        />
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

  return {
    title: page.data.title,
    description: page.data.description,
    alternates: { canonical: page.url },
    openGraph: {
      type: "article",
      url: absoluteUrl(page.url),
      title: page.data.title,
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
      title: page.data.title,
      description: page.data.description,
      images: [getPageImage(page).url],
    },
  };
}
