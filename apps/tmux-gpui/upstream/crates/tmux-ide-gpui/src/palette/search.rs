//! Prepared search fields keep ranking independent of rendering and input.
//!
//! Scoring is nucleo's fzf algorithm, as in Helix. Every space-separated term
//! must match the name or the context, and fzf's `'exact`, `^prefix`,
//! `suffix$`, and `!negation` syntax applies per term. Highlights are
//! computed here as byte ranges so rendering never runs the matcher.

use super::Entry;
use nucleo_matcher::{
    Config, Matcher, Utf32Str, Utf32String,
    pattern::{Atom, CaseMatching, Normalization, Pattern},
};
use std::ops::Range;
use unicode_segmentation::UnicodeSegmentation;

/// Lists up to this many candidates are ranked inline; larger ones go to the
/// background executor so a keystroke never waits on a long project list.
pub(super) const INLINE_CANDIDATES: usize = 512;
/// Matching is O(needle × haystack), so both are capped. Longer text is
/// still shown, only its tail is not searched.
const MAX_QUERY_CHARS: usize = 256;
const MAX_TERMS: usize = 16;
const MAX_HAYSTACK_GRAPHEMES: usize = 512;
/// A term found in the name outranks the same term found in the context.
const NAME_WEIGHT: u32 = 2;

pub(super) struct Fields {
    name: Utf32String,
    context: Utf32String,
}

impl Fields {
    pub(super) fn new(name: &str, context: &str) -> Self {
        Self {
            name: bounded(name).into(),
            context: bounded(context).into(),
        }
    }
}

fn bounded(text: &str) -> &str {
    let end = if text.is_ascii() {
        text.len().min(MAX_HAYSTACK_GRAPHEMES)
    } else {
        text.grapheme_indices(true)
            .nth(MAX_HAYSTACK_GRAPHEMES)
            .map_or(text.len(), |(start, _)| start)
    };
    &text[..end]
}

/// A parsed, bounded query. Parsing is cheap and done once per keystroke.
pub(super) struct Query(Pattern);

impl Query {
    pub(super) fn parse(text: &str) -> Self {
        let end = text
            .char_indices()
            .nth(MAX_QUERY_CHARS)
            .map_or(text.len(), |(start, _)| start);
        // Nucleo splits terms on spaces alone; a tab or newline is a separator too.
        let text = text[..end].split_whitespace().collect::<Vec<_>>().join(" ");
        let mut pattern = Pattern::parse(&text, CaseMatching::Ignore, Normalization::Smart);
        pattern.atoms.truncate(MAX_TERMS);
        Self(pattern)
    }
}

/// Byte ranges of matched characters in an entry's label and detail.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct Highlights {
    pub label: Vec<Range<usize>>,
    pub detail: Vec<Range<usize>>,
}

/// One visible palette row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Hit {
    pub index: usize,
    /// Visible ancestors above this row, for indentation in entry order.
    pub depth: usize,
    pub highlights: Highlights,
}

pub(super) fn matcher() -> Matcher {
    Matcher::new(Config::DEFAULT)
}

/// Ranks `candidates` (indices into `entries`) best first. Ties keep the
/// shorter name first and then entry order, as fzf's length tiebreak does;
/// an empty query keeps entry order so nested rows stay under their parents.
pub(super) fn rank(
    entries: &[Entry],
    candidates: impl IntoIterator<Item = usize>,
    query: &Query,
    matcher: &mut Matcher,
) -> Vec<Hit> {
    let mut indices = Indices::default();
    let mut ranked: Vec<_> = candidates
        .into_iter()
        .filter_map(|index| {
            let entry = &entries[index];
            let score = score(&entry.fields, &query.0.atoms, matcher, &mut indices)?;
            let highlights = Highlights {
                label: byte_ranges(&entry.label, &mut indices.name),
                detail: byte_ranges(&entry.detail, &mut indices.context),
            };
            Some((score, entry.fields.name.len(), index, highlights))
        })
        .collect();
    if !query.0.atoms.is_empty() {
        ranked.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
    }
    let mut visible = vec![false; entries.len()];
    for (_, _, index, _) in &ranked {
        visible[*index] = true;
    }
    ranked
        .into_iter()
        .map(|(_, _, index, highlights)| Hit {
            index,
            depth: depth(entries, &visible, index),
            highlights,
        })
        .collect()
}

fn depth(entries: &[Entry], visible: &[bool], mut index: usize) -> usize {
    let mut depth = 0;
    // Parents always precede their children, which bounds the walk.
    while let Some(parent) = entries[index].parent.filter(|parent| visible[*parent]) {
        depth += 1;
        index = parent;
    }
    depth
}

#[derive(Default)]
struct Indices {
    name: Vec<u32>,
    context: Vec<u32>,
    scratch: Vec<u32>,
}

fn score(
    fields: &Fields,
    atoms: &[Atom],
    matcher: &mut Matcher,
    indices: &mut Indices,
) -> Option<u32> {
    indices.name.clear();
    indices.context.clear();
    let name = fields.name.slice(..);
    let context = fields.context.slice(..);
    atoms.iter().try_fold(0, |total, atom| {
        if atom.negative {
            // A negated term excludes the entry when either field contains it.
            atom.score(name, matcher)?;
            atom.score(context, matcher)?;
            return Some(total);
        }
        let in_name = matched(atom, name, matcher, &mut indices.scratch, &mut indices.name);
        let in_context = matched(
            atom,
            context,
            matcher,
            &mut indices.scratch,
            &mut indices.context,
        );
        let best = in_name
            .map(|score| u32::from(score) * NAME_WEIGHT)
            .max(in_context.map(u32::from))?;
        Some(total + best)
    })
}

/// Scores one term against one field, keeping its indices only on a match.
fn matched(
    atom: &Atom,
    haystack: Utf32Str<'_>,
    matcher: &mut Matcher,
    scratch: &mut Vec<u32>,
    indices: &mut Vec<u32>,
) -> Option<u16> {
    scratch.clear();
    let score = atom.indices(haystack, matcher, scratch)?;
    indices.extend_from_slice(scratch);
    Some(score)
}

/// Converts nucleo's character indices into merged byte ranges of `text`.
/// Nucleo indexes bytes for ASCII text and graphemes otherwise; indices past
/// the end of `text` (from the context's badge and keywords) are dropped.
fn byte_ranges(text: &str, indices: &mut Vec<u32>) -> Vec<Range<usize>> {
    indices.sort_unstable();
    indices.dedup();
    let mut ranges: Vec<Range<usize>> = Vec::new();
    let mut push = |range: Range<usize>| match ranges.last_mut() {
        Some(last) if last.end == range.start => last.end = range.end,
        _ => ranges.push(range),
    };
    if text.is_ascii() {
        for index in indices.iter().map(|index| *index as usize) {
            if index < text.len() {
                push(index..index + 1);
            }
        }
    } else {
        let mut wanted = indices.iter().map(|index| *index as usize).peekable();
        for (position, (start, grapheme)) in text.grapheme_indices(true).enumerate() {
            let Some(next) = wanted.peek() else {
                break;
            };
            if *next == position {
                wanted.next();
                push(start..start + grapheme.len());
            }
        }
    }
    ranges
}

#[cfg(test)]
mod tests;
