import { describe, expect, it, vi } from "vitest";
import {
  resolveMarkdownFileLinkMeta,
  resolveMarkdownFileLinkTarget,
  rewriteMarkdownFileUriHref,
} from "../src/lib/markdownLinks";
import { renderMarkdown } from "../src/lib/markdown";

describe("resolveMarkdownFileLinkTarget", () => {
  it("resolves absolute posix paths verbatim", () => {
    expect(resolveMarkdownFileLinkTarget("/Users/thijs/dev/tmux-ide/src/main.ts")).toBe(
      "/Users/thijs/dev/tmux-ide/src/main.ts",
    );
  });

  it("resolves bare relative paths when no cwd is provided", () => {
    expect(resolveMarkdownFileLinkTarget("src/main.ts:42")).toBe("src/main.ts:42");
  });

  it("joins relative paths against cwd when one is provided", () => {
    expect(resolveMarkdownFileLinkTarget("src/main.ts:42", "/work/project")).toBe(
      "/work/project/src/main.ts:42",
    );
  });

  it("strips the file:// scheme on file URLs", () => {
    expect(resolveMarkdownFileLinkTarget("file:///work/project/AGENTS.md")).toBe(
      "/work/project/AGENTS.md",
    );
  });

  it("maps #L line anchors to editor :line:col suffixes", () => {
    expect(resolveMarkdownFileLinkTarget("/work/project/src/main.ts#L42C7")).toBe(
      "/work/project/src/main.ts:42:7",
    );
  });

  it("rejects external https:// urls", () => {
    expect(resolveMarkdownFileLinkTarget("https://example.com/docs")).toBeNull();
  });

  it("rejects app routes that look path-shaped but aren't files", () => {
    expect(resolveMarkdownFileLinkTarget("/chat/settings")).toBeNull();
  });

  it("rejects anchor-only hrefs", () => {
    expect(resolveMarkdownFileLinkTarget("#section")).toBeNull();
  });
});

describe("resolveMarkdownFileLinkMeta", () => {
  it("returns rich metadata for an absolute path with line/column", () => {
    const meta = resolveMarkdownFileLinkMeta("/work/project/src/main.ts:42:7", "/work/project");
    expect(meta).toMatchObject({
      filePath: "/work/project/src/main.ts",
      targetPath: "/work/project/src/main.ts:42:7",
      basename: "main.ts",
      line: 42,
      column: 7,
    });
  });

  it("formats displayPath relative to the cwd", () => {
    const meta = resolveMarkdownFileLinkMeta(
      "file:///work/project/src/main.ts#L10",
      "/work/project",
    );
    expect(meta?.displayPath).toBe("project/src/main.ts:10");
  });
});

describe("rewriteMarkdownFileUriHref", () => {
  it("rewrites file:// hrefs to bare paths preserving hash", () => {
    expect(rewriteMarkdownFileUriHref("file:///work/project/main.ts#L1")).toBe(
      "/work/project/main.ts#L1",
    );
  });

  it("returns null for non-file hrefs", () => {
    expect(rewriteMarkdownFileUriHref("https://example.com")).toBeNull();
    expect(rewriteMarkdownFileUriHref(undefined)).toBeNull();
  });
});

describe("renderMarkdown — file link decoration", () => {
  it("renders plain external links as normal anchors", () => {
    const html = renderMarkdown("[docs](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain("chat-file-link");
  });

  it("renders file:// links as chat-file-link chips with data attributes", () => {
    const html = renderMarkdown("[main](file:///work/project/src/main.ts)");
    expect(html).toContain('class="chat-file-link"');
    expect(html).toContain('data-file-path="/work/project/src/main.ts"');
    expect(html).toContain('href="/work/project/src/main.ts"');
  });

  it("decorates relative paths as file chips, resolving them against cwd", () => {
    const html = renderMarkdown("[main](src/main.ts:42)", { cwd: "/work/project" });
    expect(html).toContain('class="chat-file-link"');
    expect(html).toContain('data-file-path="/work/project/src/main.ts"');
    expect(html).toContain('data-file-line="42"');
  });

  it("decorates relative paths even with no cwd (host resolves)", () => {
    const html = renderMarkdown("[main](src/main.ts)");
    expect(html).toContain('class="chat-file-link"');
    expect(html).toContain('data-file-path="src/main.ts"');
  });

  it("delegated click on a rendered file link fires the host callback", () => {
    // Render to a real DOM container, then attach a delegated click handler
    // matching what MessageBubble does. Click the anchor and assert the
    // callback received the expected meta.
    const html = renderMarkdown("[main](src/main.ts:42)", { cwd: "/work/project" });
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    const onOpen = vi.fn();
    container.addEventListener("click", (event) => {
      const anchor = (event.target as HTMLElement | null)?.closest<HTMLAnchorElement>(
        "a.chat-file-link",
      );
      if (!anchor) return;
      event.preventDefault();
      onOpen({
        filePath: anchor.dataset.filePath,
        line: anchor.dataset.fileLine ? Number(anchor.dataset.fileLine) : undefined,
      });
    });

    const anchor = container.querySelector<HTMLAnchorElement>("a.chat-file-link");
    expect(anchor).not.toBeNull();
    anchor!.click();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0][0]).toMatchObject({
      filePath: "/work/project/src/main.ts",
      line: 42,
    });

    container.remove();
  });
});
