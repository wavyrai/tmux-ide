import { MARKDOWN_VARY, homeMarkdown } from "@/lib/agent-markdown";
import { canonicalUrl } from "@/lib/site";

export const revalidate = false;

export function GET() {
  return new Response(homeMarkdown(), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      Vary: MARKDOWN_VARY,
      Link: `<${canonicalUrl("/")}>; rel="canonical"`,
    },
  });
}
