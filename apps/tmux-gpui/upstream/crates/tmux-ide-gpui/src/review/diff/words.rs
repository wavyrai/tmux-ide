//! Which words changed within a changed line. A removed line is paired with
//! the added line that replaced it, as the side-by-side view pairs them, and
//! the words they do not share are emphasised. Lines too different to read
//! as an edit of each other, or too long to compare cheaply, get none.
use super::{Kind, Lines};
use std::ops::Range;

/// Words compared per line at most: the comparison is their product.
const MAX_TOKENS: usize = 400;
/// Pairs share at least this much of their text to count as an edit.
const MIN_SHARED: f32 = 0.4;

/// A line's words, spaces and punctuation, as byte ranges.
fn tokens(text: &str) -> Vec<Range<usize>> {
    let mut tokens = Vec::new();
    let mut start = 0;
    let mut class = None;
    for (at, c) in text.char_indices() {
        let next = if c.is_alphanumeric() || c == '_' {
            Some(0)
        } else if c.is_whitespace() {
            Some(1)
        } else {
            None
        };
        // Punctuation stands alone; words and spaces run on.
        if at > start && (next.is_none() || next != class) {
            tokens.push(start..at);
            start = at;
        }
        class = next;
    }
    if start < text.len() {
        tokens.push(start..text.len());
    }
    tokens
}

/// A changed line's byte ranges marked as changed.
type Words = Vec<Range<u32>>;

/// One line's tokens, and which of them the other line shares.
struct Tokens {
    tokens: Vec<Range<usize>>,
    kept: Vec<bool>,
}

/// The tokens of `old` and `new` the two share, by a longest common
/// subsequence; none past `MAX_TOKENS`.
fn shared(old: &str, new: &str) -> Option<(Tokens, Tokens)> {
    let (a, b) = (tokens(old), tokens(new));
    if a.len() > MAX_TOKENS || b.len() > MAX_TOKENS {
        return None;
    }
    let width = b.len() + 1;
    let mut table = vec![0_u16; (a.len() + 1) * width];
    for i in (0..a.len()).rev() {
        for j in (0..b.len()).rev() {
            table[i * width + j] = if old[a[i].clone()] == new[b[j].clone()] {
                table[(i + 1) * width + j + 1] + 1
            } else {
                table[(i + 1) * width + j].max(table[i * width + j + 1])
            };
        }
    }
    let (mut kept_a, mut kept_b) = (vec![false; a.len()], vec![false; b.len()]);
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        if old[a[i].clone()] == new[b[j].clone()] {
            kept_a[i] = true;
            kept_b[j] = true;
            i += 1;
            j += 1;
        } else if table[(i + 1) * width + j] >= table[i * width + j + 1] {
            i += 1;
        } else {
            j += 1;
        }
    }
    Some((
        Tokens {
            tokens: a,
            kept: kept_a,
        },
        Tokens {
            tokens: b,
            kept: kept_b,
        },
    ))
}

/// The tokens not kept, merged into runs, as `u32` byte ranges.
fn changed(side: &Tokens) -> Words {
    let mut runs: Words = Vec::new();
    for (token, kept) in side.tokens.iter().zip(&side.kept) {
        if *kept {
            continue;
        }
        let range = u32::try_from(token.start).unwrap_or(u32::MAX)
            ..u32::try_from(token.end).unwrap_or(u32::MAX);
        match runs.last_mut() {
            Some(last) if last.end == range.start => last.end = range.end,
            _ => runs.push(range),
        }
    }
    runs
}

/// The changed words of `old` replaced by `new`, each side's byte ranges;
/// none when the lines are not an edit of each other.
fn pair(old: &str, new: &str) -> Option<(Words, Words)> {
    let (left, right) = shared(old, new)?;
    let common: usize = left
        .tokens
        .iter()
        .zip(&left.kept)
        .filter(|(_, kept)| **kept)
        .map(|(token, _)| token.len())
        .sum();
    let total = old.len() + new.len();
    if total == 0 || (2 * common) as f32 / (total as f32) < MIN_SHARED {
        return None;
    }
    Some((changed(&left), changed(&right)))
}

/// The changed words of each line of `lines` in `range`, by its place in
/// the range, each removed line compared with the added line that replaced
/// it, as the side-by-side view pairs them, wherever that line is.
pub(crate) fn emphasis(lines: &Lines, range: Range<usize>) -> Vec<Words> {
    range
        .map(|index| {
            let Some(partner) = lines.partner(index) else {
                return Vec::new();
            };
            let removed = lines
                .get(index)
                .is_some_and(|line| line.kind == Kind::Removed);
            let (old, new) = if removed {
                (index, partner)
            } else {
                (partner, index)
            };
            match pair(lines.text(old), lines.text(new)) {
                Some((left, _)) if removed => left,
                Some((_, right)) => right,
                None => Vec::new(),
            }
        })
        .collect()
}
