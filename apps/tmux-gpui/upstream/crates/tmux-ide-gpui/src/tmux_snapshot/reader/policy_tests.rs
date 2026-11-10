#![allow(clippy::unwrap_used)]
use super::*;
use bezel_markdown::{BlockKind, Mark};
use std::{collections::BTreeMap, path::PathBuf};

#[test]
fn only_web_links_reach_the_system_browser() {
    assert_eq!(
        link_action("https://tmux-ide.dev/docs"),
        LinkAction::Web("https://tmux-ide.dev/docs".into())
    );
    assert_eq!(
        link_action("http://localhost:3000/"),
        LinkAction::Web("http://localhost:3000/".into())
    );
    assert_eq!(link_action("#what-changed"), LinkAction::Jump);
    for refused in [
        "mailto:owner@example.com",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "vscode://open?x",
        "x-apple.systempreferences:com.apple",
        "ssh://host",
        "tel:123",
        "data:text/html,<b>x</b>",
        "other.md",
        "../secrets.md",
        "/etc/hosts",
        "https://",
        "https://exa mple.com",
        "https://user:pass@example.com/",
        "https://user@example.com/",
        "https://:secret@example.com/",
        "docs#intro",
        "",
    ] {
        assert_eq!(link_action(refused), LinkAction::Refused, "{refused}");
    }
    let long = format!("https://example.com/{}", "a".repeat(9000));
    assert_eq!(link_action(&long), LinkAction::Refused);
}

#[test]
fn image_sources_are_classified_before_anything_loads() {
    assert_eq!(classify_image("images/a.png"), ImageSrc::Local);
    assert_eq!(classify_image("../images/a.png"), ImageSrc::Local);
    assert_eq!(
        classify_image("https://cdn.example.com/diagram.png"),
        ImageSrc::Remote("cdn.example.com/diagram.png".into())
    );
    assert_eq!(
        classify_image("HTTP://cdn.example.com/x.png"),
        ImageSrc::Remote("cdn.example.com/x.png".into())
    );
    for refused in [
        "/etc/a.png",
        "~/a.png",
        "file:///etc/a.png",
        "data:image/png;base64,AAAA",
        "//cdn.example.com/a.png",
        "\\\\host\\share\\a.png",
        "C:\\a.png",
        "a\0.png",
        "",
    ] {
        assert_eq!(classify_image(refused), ImageSrc::Refused, "{refused:?}");
    }
}

fn image_urls(doc: &Doc) -> Vec<String> {
    let mut urls = Vec::new();
    for block in &doc.blocks {
        if let BlockKind::Image { url, .. } = &block.kind {
            urls.push(url.clone());
        }
        for part in block.parts() {
            if let Some(text) = block.text_at(part) {
                for span in &text.marks {
                    if let Mark::Image(url) = &span.mark {
                        urls.push(url.clone());
                    }
                }
            }
        }
    }
    urls
}

#[test]
fn remote_images_never_reach_the_renderer() {
    let doc = bezel_markdown::parse(
        "![d](https://cdn.example.com/diagram.png)\n\nsee ![i](http://x.example/i.gif) here\n\n![f](file:///etc/a.png)\n",
    );
    let (rendered, wanted) = rewrite(&doc, &BTreeMap::new());
    assert!(wanted.is_empty());
    assert!(
        image_urls(&rendered).is_empty(),
        "{:?}",
        image_urls(&rendered)
    );
    let text: String = rendered
        .blocks
        .iter()
        .filter_map(|b| b.text_at(bezel_markdown::Part::Body))
        .map(|t| t.text.clone())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(text.contains("Remote image not loaded"), "{text}");
    assert!(text.contains("cdn.example.com/diagram.png"), "{text}");
}

#[test]
fn local_images_point_only_at_the_app_cache_once_fetched() {
    let doc = bezel_markdown::parse("![a](images/a.png)\n\n![b](../b.png)\n\n![c](/etc/c.png)\n");
    let (pending, wanted) = rewrite(&doc, &BTreeMap::new());
    assert_eq!(
        wanted,
        vec!["images/a.png".to_owned(), "../b.png".to_owned()]
    );
    // Not fetched yet: an empty source paints the placeholder; never the path as written.
    assert_eq!(image_urls(&pending), vec![String::new(), String::new()]);
    let cache = PathBuf::from("/cache/0123.png");
    let assets = BTreeMap::from([
        ("images/a.png".to_owned(), Asset::Ready(cache.clone())),
        ("../b.png".to_owned(), Asset::Refused),
    ]);
    let (ready, _) = rewrite(&doc, &assets);
    assert_eq!(image_urls(&ready), vec![cache.display().to_string()]);
    // R12: an image among text gets the same treatment, never its path as written.
    let inline = bezel_markdown::parse("see ![i](images/a.png) here\n");
    let (pending, wanted) = rewrite(&inline, &BTreeMap::new());
    assert_eq!(wanted, vec!["images/a.png".to_owned()]);
    assert_eq!(image_urls(&pending), vec![String::new()]);
    let (ready, _) = rewrite(&inline, &assets);
    assert_eq!(image_urls(&ready), vec![cache.display().to_string()]);
}

#[test]
fn at_most_64_images_are_fetched_per_document() {
    let source: String = (0..80).map(|n| format!("![i](img/{n}.png)\n\n")).collect();
    let (_, wanted) = rewrite(&bezel_markdown::parse(&source), &BTreeMap::new());
    assert_eq!(wanted.len(), MAX_IMAGES);
}

#[test]
fn raw_html_is_shown_as_text_never_interpreted() {
    let doc = bezel_markdown::parse(
        "<img src=\"https://evil.example/x.png\">\n\n<script>alert(1)</script>\n\nok <b>bold</b> <a href=\"file:///etc\">x</a>\n",
    );
    let (rendered, wanted) = rewrite(&doc, &BTreeMap::new());
    assert!(wanted.is_empty());
    assert!(image_urls(&rendered).is_empty());
    let all: String = rendered
        .blocks
        .iter()
        .flat_map(|b| {
            b.parts()
                .into_iter()
                .filter_map(|p| b.text_at(p).cloned())
                .collect::<Vec<_>>()
        })
        .map(|t| {
            // A bare address inside the markup may still autolink, as it would
            // in prose; nothing in a tag becomes a picture or a non-web link.
            assert!(
                t.marks.iter().all(|m| match &m.mark {
                    Mark::Image(_) => false,
                    Mark::Link(url) => matches!(link_action(url), LinkAction::Web(_)),
                    _ => true,
                }),
                "{t:?}"
            );
            t.text
        })
        .collect();
    assert!(all.contains("<script>alert(1)</script>"), "{all}");
    assert!(all.contains("<b>bold</b>"), "{all}");
}

#[test]
fn non_utf8_bytes_decode_with_replacement_and_say_so() {
    assert_eq!(decode(b"# Hi\n"), ("# Hi\n".to_owned(), false));
    assert_eq!(decode(b"\xef\xbb\xbf# Hi"), ("# Hi".to_owned(), false));
    let (text, lossy) = decode(b"caf\xe9 au lait");
    assert!(lossy);
    assert_eq!(text, "caf\u{fffd} au lait");
}
