import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock("./icon-provider", () => ({ useNativeIcon: () => native.value }));
import { Home, Terminal } from "./icons";

beforeEach(() => {
  native.value = undefined;
});

it("keeps native and fallback icons in the same layout box", () => {
  const open = renderToStaticMarkup(createElement(Home, { size: 18 }));
  native.value = "data:image/png;base64,YQ==";
  const mac = renderToStaticMarkup(createElement(Home, { size: 18 }));
  for (const markup of [open, mac]) {
    expect(markup).toContain('width="18"');
    expect(markup).toContain('height="18"');
    expect(markup).toContain('aria-hidden="true"');
  }
  expect(open).not.toContain("<image");
  expect(mac).toContain('preserveAspectRatio="xMidYMid meet"');
});

it("tints native symbol alpha with currentColor and isolates each mask", () => {
  native.value = "data:image/png;base64,YQ==";
  const markup = renderToStaticMarkup(
    createElement("div", null, createElement(Home), createElement(Terminal)),
  );
  const ids = [...markup.matchAll(/<mask id="([^"]+)"/gu)].map((match) => match[1]);
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(2);
  for (const id of ids) expect(markup).toContain(`mask="url(#${id})"`);
  expect(markup.match(/fill="currentColor"/gu)).toHaveLength(2);
  expect(markup.match(/mask-type:alpha/gu)).toHaveLength(2);
});
