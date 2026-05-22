import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/lib/markdown";

describe("renderMarkdown", () => {
  it("renders emphasis", () => {
    expect(renderMarkdown("**hi**")).toContain("<strong>hi</strong>");
  });

  it("renders fenced code blocks", () => {
    const html = renderMarkdown("```js\nconst x=1\n```");
    expect(html).toContain("<pre><code");
    expect(html).toContain("const x=1");
  });

  it("renders lists", () => {
    const html = renderMarkdown("- one\n- two");
    expect(html).toContain("<ul>");
    expect(html.match(/<li>/g)).toHaveLength(2);
  });

  it("strips script tags", () => {
    expect(renderMarkdown("<script>alert(1)</script>")).not.toContain("<script>");
  });

  it("strips dangerous javascript hrefs", () => {
    const html = renderMarkdown("[click](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain('href="javascript:');
  });
});
