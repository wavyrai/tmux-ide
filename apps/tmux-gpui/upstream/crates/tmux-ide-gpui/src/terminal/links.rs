//! Resolve user-selected links within the painted pane or popup only: plain
//! `http://` and `https://` addresses in the text, and explicit (OSC 8)
//! hyperlinks to such addresses when a frame carries them. Nothing else opens:
//! not file paths, not other schemes.
use super::{HIDDEN, selection::shown};
use std::ops::Range;

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
#[cfg(test)]
pub(crate) fn logical_web_link(
    cells: &[&herdr_client::protocol::CellData],
    selected: usize,
    hyperlinks: &[String],
) -> Option<String> {
    logical_web_link_span(cells, selected, hyperlinks).map(|(url, _)| url)
}

/// [`logical_web_link`] and the indices of the cells it covers, so a cue can
/// mark exactly what a click opens. A wide character's padding cell belongs
/// to it.
pub(crate) fn logical_web_link_span(
    cells: &[&herdr_client::protocol::CellData],
    selected: usize,
    hyperlinks: &[String],
) -> Option<(String, Range<usize>)> {
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
        let url = web_url(hyperlinks.get(index as usize)?)?;
        let carries = |i: usize| cells[i].hyperlink == Some(index);
        let mut start = source;
        while start > 0 && carries(start - 1) {
            start -= 1;
        }
        let mut end = source + 1;
        while end < cells.len() && (carries(end) || cells[end].skip) {
            end += 1;
        }
        return Some((url, start..end));
    }
    let mut text = String::new();
    // The byte at which each cell's text starts; a padding cell starts where
    // its wide character ends.
    let mut starts = Vec::with_capacity(cells.len());
    let mut hit = None;
    for (index, cell) in cells.iter().enumerate() {
        if index == source {
            hit = Some(text.len());
        }
        starts.push(text.len());
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
    let url = web_url(&text[range.clone()])?;
    let first = (0..cells.len()).find(|&i| !cells[i].skip && starts[i] >= range.start)?;
    let end = starts
        .iter()
        .rposition(|&start| start < range.end)
        .map_or(first + 1, |last| last + 1);
    let mut end = end.max(first + 1);
    while end < cells.len() && cells[end].skip {
        end += 1;
    }
    Some((url, first..end))
}
