//! Find in a reader document: case-insensitive over every text part, bounded.
use bezel_markdown::{Cursor, Doc, Selection};

/// More than this many matches reads as "N+".
pub(in crate::tmux_snapshot) const MAX_MATCHES: usize = 1000;

fn same(a: char, b: char) -> bool {
    a == b || a.to_lowercase().eq(b.to_lowercase())
}

/// Every match of `query`, in document order, at most [`MAX_MATCHES`].
pub(in crate::tmux_snapshot) fn matches(doc: &Doc, query: &str) -> Vec<Selection> {
    let needle: Vec<char> = query.chars().collect();
    let mut found = Vec::new();
    if needle.is_empty() {
        return found;
    }
    for (index, block) in doc.blocks.iter().enumerate() {
        for part in block.parts() {
            let Some(text) = block.text_at(part) else {
                continue;
            };
            let haystack: Vec<(usize, char)> = text.text.char_indices().collect();
            let mut at = 0;
            while at + needle.len() <= haystack.len() {
                if haystack[at..at + needle.len()]
                    .iter()
                    .zip(&needle)
                    .all(|((_, a), b)| same(*a, *b))
                {
                    let start = haystack[at].0;
                    let end = haystack
                        .get(at + needle.len())
                        .map_or(text.text.len(), |(offset, _)| *offset);
                    found.push(Selection::new(
                        Cursor::new(index, part, start),
                        Cursor::new(index, part, end),
                    ));
                    if found.len() == MAX_MATCHES {
                        return found;
                    }
                    at += needle.len();
                } else {
                    at += 1;
                }
            }
        }
    }
    found
}

/// The next (or previous) match, wrapping at either end.
pub(in crate::tmux_snapshot) fn step(
    current: Option<usize>,
    count: usize,
    forward: bool,
) -> Option<usize> {
    if count == 0 {
        return None;
    }
    Some(match (current, forward) {
        (None, true) => 0,
        (None, false) => count - 1,
        (Some(at), true) => (at + 1) % count,
        (Some(at), false) => (at + count - 1) % count,
    })
}

pub(in crate::tmux_snapshot) fn count_label(current: Option<usize>, count: usize) -> String {
    match (current, count) {
        (_, 0) => "No matches".into(),
        (_, n) if n >= MAX_MATCHES => format!("{MAX_MATCHES}+"),
        (Some(at), n) => format!("{} of {n}", at + 1),
        (None, n) => format!("{n} found"),
    }
}

#[cfg(test)]
#[path = "find_tests.rs"]
mod tests;
