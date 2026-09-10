import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { WidgetRenderer } from "./widget-renderer";
const render = (id: string, args: unknown) =>
  renderToStaticMarkup(
    createElement(WidgetRenderer, {
      marker: { id, args, lineIndex: 0 },
      readAsset: async () => {
        throw Error("No asset expected");
      },
    }),
  );
it("renders descriptor Markdown as escaped elements, not executable HTML", () => {
  const html = render("markdown", {
    text: "# Hello\n\n<script>alert(1)</script>\n\n[bad](javascript:alert)",
  });
  expect(html).toContain("<h1>Hello</h1>");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain('href="javascript:');
});
it("refuses arbitrary widget ids and unsafe image media", () => {
  expect(render("html", { text: "<h1>unsafe</h1>" })).toContain("unavailable");
  expect(render("image", { media: "image/svg+xml", data: "AAAA" })).toContain("unavailable");
});
it("makes card actions inert without input authority", () => {
  const html = render("card", {
    title: "Agent",
    items: [
      { type: "button", label: "Continue", input: "secret", submit: true },
      { type: "progress", value: 42 },
    ],
  });
  expect(html).toContain("disabled");
  expect(html).toContain('value="42"');
  expect(html).not.toContain("secret");
});
