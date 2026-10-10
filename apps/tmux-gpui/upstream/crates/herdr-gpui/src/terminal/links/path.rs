//! Local file paths in one row of terminal text, the way a compiler, a test
//! runner, or `git status` prints them. Reading the row is all this does:
//! whether the file exists is only checked, off the UI thread, once the path
//! is clicked.

use super::super::selection::separates;
use std::ops::Range;

/// The longest path read from a row, Linux's `PATH_MAX`.
const MAX_PATH_BYTES: usize = 4096;

/// The byte range of the file path in one row's `text` covering the byte at
/// `hit`, a `:line` or `:line:column` suffix included, the path without that
/// suffix, and whether the path runs to the end of the row, where it may
/// continue on the next one.
pub(super) fn plain_path(text: &str, hit: usize) -> Option<(Range<usize>, &str, bool)> {
    if text.get(hit..)?.chars().next().is_none_or(separates) {
        return None;
    }
    let start = text[..hit]
        .char_indices()
        .rev()
        .find(|(_, c)| separates(*c))
        .map_or(0, |(index, c)| index + c.len_utf8());
    let end = text[hit..].find(separates).map_or(text.len(), |i| hit + i);
    // Punctuation closing a sentence, or the colon after a location, is not
    // part of the path before it.
    let token = text[start..end].trim_end_matches(['.', ':', '!', '?']);
    if hit >= start + token.len() {
        return None;
    }
    let path = without_location(token);
    // A bare name such as `README.md` or `v1.2` reads as a path only when
    // a location says so, as in `main.rs:12`.
    if !path.contains('/') && path.len() == token.len() {
        return None;
    }
    looks_like_path(path).then_some((start..start + token.len(), path, end == text.len()))
}

/// `token` without a trailing `:line` or `:line:column`.
fn without_location(token: &str) -> &str {
    let mut path = token;
    for _ in 0..2 {
        match path.rsplit_once(':') {
            Some((rest, number))
                if !number.is_empty()
                    && number.len() <= 9
                    && number.bytes().all(|b| b.is_ascii_digit()) =>
            {
                path = rest;
            }
            _ => break,
        }
    }
    path
}

fn looks_like_path(path: &str) -> bool {
    if path.is_empty() || path.len() > MAX_PATH_BYTES {
        return false;
    }
    // A scheme, an `scp` host, or a drive letter is not a local path here.
    if path.contains(':') {
        return false;
    }
    // `~user` names another account's home, which is not resolved.
    if path.starts_with('~') && path != "~" && !path.starts_with("~/") {
        return false;
    }
    let name = path
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or_default();
    !matches!(name, "" | "." | ".." | "~")
}
