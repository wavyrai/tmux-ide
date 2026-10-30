//! Resolve user-selected links within the painted pane or popup only: web
//! addresses, and the local file paths a pane prints, which open only on a
//! link-modifier click on the machine that runs the pane.
use super::{HIDDEN, selection::shown};
use std::ops::Range;

mod path;

pub(super) const MAX_ROW_BYTES: usize = 32768;

fn web_url(value: &str) -> Option<String> {
    crate::web_url::WebUrl::try_from(value)
        .ok()
        .map(String::from)
}

/// The byte range of the plain web URL in one row's `text` that covers the
/// byte at `hit`, trimmed of the prose punctuation around it, and whether the
/// URL runs to the end of the row, where it may continue off-screen or on the
/// next row.
pub(super) fn plain_url(text: &str, hit: usize) -> Option<(Range<usize>, bool)> {
    for (start, _) in text.match_indices("http") {
        if start > hit {
            break;
        }
        let tail = &text[start..];
        if !tail.starts_with("http://") && !tail.starts_with("https://") {
            continue;
        }
        let end = tail
            .find(|c: char| {
                c.is_whitespace() || c.is_control() || matches!(c, '<' | '>' | '"' | '\'' | '`')
            })
            .unwrap_or(tail.len());
        // Check the original token: punctuation at the edge may be part of a
        // destination continuing off-screen or on the next row.
        let open = end == tail.len();
        let mut candidate = tail[..end].trim_end_matches(['.', ',', ';', ':', '!', '?']);
        for (open, close) in [('(', ')'), ('[', ']'), ('{', '}')] {
            let excess = candidate
                .matches(close)
                .count()
                .saturating_sub(candidate.matches(open).count());
            for _ in 0..excess {
                let Some(trimmed) = candidate.strip_suffix(close) else {
                    break;
                };
                candidate = trimmed;
            }
        }
        if hit < start + candidate.len() {
            return Some((start..start + candidate.len(), open));
        }
        if open {
            return None;
        }
    }
    None
}

/// Resolve a bounded, already-proven logical line without constructing a flat frame.
/// The caller owns pane bounds and soft-wrap provenance; only web links escape.
pub(crate) fn logical_web_link(
    cells: &[&herdr_client::protocol::CellData],
    selected: usize,
    hyperlinks: &[String],
) -> Option<String> {
    if cells.len() > 8192 {
        return None;
    }
    let mut source = selected;
    while cells.get(source)?.skip && source > 0 {
        source -= 1;
    }
    let cell = cells.get(source)?;
    if cell.modifier & HIDDEN != 0 {
        return None;
    }
    if let Some(index) = cells.get(selected)?.hyperlink.or(cell.hyperlink) {
        return web_url(hyperlinks.get(index as usize)?);
    }
    let mut text = String::new();
    let mut hit = None;
    for (index, cell) in cells.iter().enumerate() {
        if index == source {
            hit = Some(text.len());
        }
        if cell.skip {
            continue;
        }
        let symbol = shown(cell);
        if text.len() + symbol.len() > MAX_ROW_BYTES {
            return None;
        }
        text.push_str(symbol);
    }
    let (range, truncated) = plain_url(&text, hit?)?;
    if truncated {
        return None;
    }
    web_url(&text[range])
}
