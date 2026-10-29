import { MARKDOWN_VARY, frontmatter, notFoundMarkdown } from "@/lib/agent-markdown";
import { docLastModified } from "@/lib/git-dates";
import { SITE_DESCRIPTION } from "@/lib/site";
import { getLLMText, source } from "@/lib/source";

export const revalidate = false;

export async function GET(_req: Request, { params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) {
    return new Response(notFoundMarkdown(["/docs", ...(slug ?? [])].join("/")), {
      status: 404,
      headers: { "Content-Type": "text/markdown; charset=utf-8", Vary: MARKDOWN_VARY },
    });
  }

  const meta = frontmatter({
    title: page.data.metaTitle ?? page.data.title,
    description: page.data.description ?? SITE_DESCRIPTION,
    path: page.url,
    lastUpdated: docLastModified(page.path),
  });
  return new Response(`${meta}${await getLLMText(page)}`, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      Vary: MARKDOWN_VARY,
    },
  });
}

export function generateStaticParams() {
  return source.generateParams();
}
