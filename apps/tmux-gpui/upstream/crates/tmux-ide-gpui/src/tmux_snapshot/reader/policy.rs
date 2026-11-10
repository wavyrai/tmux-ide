//! What the reader lets a document do (#756). Pure: no gpui, no file access.
//!
//! - A link opens the system browser only for an http or https address that
//!   passes the app's `WebUrl` check; `#heading` scrolls; anything else does
//!   nothing.
//! - An image loads only from a copy the daemon handed the app and the app put
//!   in its own cache. A remote image is never fetched; it becomes a line of
//!   text with the address. The path as written never reaches gpui.
//! - Raw HTML is text: the parser keeps it as written and nothing here turns
//!   it back into markup.
use bezel_markdown::{Block, BlockKind, Doc, Mark, MarkSpan, Text};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
};

/// Images fetched per document; the rest show as text.
pub(in crate::tmux_snapshot) const MAX_IMAGES: usize = 64;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::tmux_snapshot) enum LinkAction {
    /// A `#fragment`: bezel-markdown scrolls to the heading it names.
    Jump,
    /// Opened in the system browser, as normalized by `WebUrl`.
    Web(String),
    /// Not handed to the system at all.
    Refused,
}

pub(in crate::tmux_snapshot) fn link_action(url: &str) -> LinkAction {
    if url.starts_with('#') {
        return LinkAction::Jump;
    }
    match crate::web_url::WebUrl::try_from(url) {
        Ok(web) => LinkAction::Web(web.into()),
        Err(_) => LinkAction::Refused,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::tmux_snapshot) enum ImageSrc {
    /// Relative to the document; the daemon decides whether it may be read.
    Local,
    /// http or https, never fetched. Holds the host and path for the notice.
    Remote(String),
    /// Absolute, home-relative, another scheme, or malformed.
    Refused,
}

fn scheme(value: &str) -> Option<&str> {
    let (scheme, _) = value.split_once(':')?;
    let mut chars = scheme.chars();
    (chars.next()?.is_ascii_alphabetic()
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')))
    .then_some(scheme)
}

pub(in crate::tmux_snapshot) fn classify_image(url: &str) -> ImageSrc {
    if url.is_empty()
        || url.len() > 2048
        || url.contains('\0')
        || url.starts_with("//")
        || url.starts_with('\\')
        || url.starts_with('/')
        || url.starts_with('~')
    {
        return ImageSrc::Refused;
    }
    match scheme(url) {
        Some(s) if s.eq_ignore_ascii_case("http") || s.eq_ignore_ascii_case("https") => {
            let rest = url[s.len() + 1..].trim_start_matches('/');
            let shown: String = rest
                .split(['?', '#'])
                .next()
                .unwrap_or_default()
                .chars()
                .filter(|c| !c.is_control())
                .take(120)
                .collect();
            ImageSrc::Remote(shown)
        }
        Some(_) => ImageSrc::Refused,
        None => ImageSrc::Local,
    }
}

/// Where a local image stands.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::tmux_snapshot) enum Asset {
    /// Copied into the app's cache, checked, ready to paint.
    Ready(PathBuf),
    /// Outside the folder or repository, not an image type, or not admissible.
    Refused,
    Missing,
    TooLarge,
    /// The daemon could not be asked; tried again on the next change.
    Failed,
}

fn notice(text: String, link: Option<(&str, &str)>) -> Text {
    let mut out = Text::plain(text);
    if let Some((label, url)) = link {
        out.text.push_str("  ");
        let start = out.text.len();
        out.text.push_str(label);
        out.marks.push(MarkSpan {
            range: start..out.text.len(),
            mark: Mark::Link(url.to_owned()),
        });
    }
    out
}

/// The line a picture that is not shown leaves in its place.
fn stand_in(url: &str, asset: Option<&Asset>, over_limit: bool) -> Option<Text> {
    match classify_image(url) {
        ImageSrc::Remote(shown) => Some(notice(
            format!("Remote image not loaded  {shown}"),
            matches!(link_action(url), LinkAction::Web(_)).then_some(("Open in browser", url)),
        )),
        ImageSrc::Refused => Some(notice(format!("Image not shown  {url}"), None)),
        ImageSrc::Local if over_limit => Some(notice(
            format!("Image not loaded: more than {MAX_IMAGES} images  {url}"),
            None,
        )),
        ImageSrc::Local => match asset {
            None | Some(Asset::Ready(_)) => None,
            Some(Asset::Refused) => Some(notice(format!("Image not shown  {url}"), None)),
            Some(Asset::Missing) => Some(notice(format!("Image not found  {url}"), None)),
            Some(Asset::TooLarge) => Some(notice(format!("Image too large to show  {url}"), None)),
            Some(Asset::Failed) => Some(notice(format!("Image not loaded  {url}"), None)),
        },
    }
}

/// What gpui may load for a local image that is shown: the cache copy, or an
/// empty source (the placeholder) while it is on its way.
fn painted(asset: Option<&Asset>) -> String {
    match asset {
        Some(Asset::Ready(path)) => path.display().to_string(),
        _ => String::new(),
    }
}

/// The document as the reader paints it, and the local images it still needs,
/// in document order, at most [`MAX_IMAGES`].
pub(in crate::tmux_snapshot) fn rewrite(
    doc: &Doc,
    assets: &BTreeMap<String, Asset>,
) -> (Doc, Vec<String>) {
    let mut wanted: Vec<String> = Vec::new();
    let mut seen = BTreeSet::new();
    let mut admit = |url: &str| -> bool {
        if classify_image(url) != ImageSrc::Local {
            return false;
        }
        if seen.contains(url) {
            return true;
        }
        if seen.len() >= MAX_IMAGES {
            return false;
        }
        seen.insert(url.to_owned());
        if !assets.contains_key(url) {
            wanted.push(url.to_owned());
        }
        true
    };
    let mut blocks = Vec::with_capacity(doc.blocks.len());
    for block in &doc.blocks {
        let mut block = block.clone();
        if let BlockKind::Image { url, .. } = &block.kind {
            let url = url.clone();
            let admitted = admit(&url);
            match stand_in(&url, assets.get(&url), !admitted) {
                Some(text) => {
                    block = Block {
                        kind: BlockKind::Paragraph(text),
                        ..block
                    }
                }
                None => {
                    if let BlockKind::Image {
                        url: painted_url, ..
                    } = &mut block.kind
                    {
                        *painted_url = painted(assets.get(&url));
                    }
                }
            }
        }
        for part in block.parts() {
            let Some(text) = block.text_at_mut(part) else {
                continue;
            };
            text.marks.retain_mut(|span| {
                let Mark::Image(url) = &span.mark else {
                    return true;
                };
                let url = url.clone();
                let admitted = admit(&url);
                match (classify_image(&url), assets.get(&url)) {
                    (ImageSrc::Local, None | Some(Asset::Ready(_))) if admitted => {
                        span.mark = Mark::Image(painted(assets.get(&url)));
                        true
                    }
                    (ImageSrc::Remote(_), _) if matches!(link_action(&url), LinkAction::Web(_)) => {
                        span.mark = Mark::Link(url);
                        true
                    }
                    _ => false,
                }
            });
        }
        blocks.push(block);
    }
    (Doc { blocks }, wanted)
}

/// The file's text, and whether any bytes were not UTF-8 (shown as U+FFFD).
pub(in crate::tmux_snapshot) fn decode(bytes: &[u8]) -> (String, bool) {
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
    match std::str::from_utf8(bytes) {
        Ok(text) => (text.to_owned(), false),
        Err(_) => (String::from_utf8_lossy(bytes).into_owned(), true),
    }
}

#[cfg(test)]
#[path = "policy_tests.rs"]
mod tests;
