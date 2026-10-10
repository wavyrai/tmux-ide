//! Syntax colouring for a review's diff, worked out in the background a hunk
//! at a time as hunks come into view, so drawing only applies prepared spans
//! and a huge change is never coloured whole. Each file's grammar follows
//! its name. Removed lines are read in the order the old file had them and
//! added lines in the new file's, unchanged lines in both; every hunk starts
//! afresh, since the lines between hunks are not in the diff. Tokens are
//! classified, not coloured: the window colours each class from its own
//! theme, so a theme change recolours the diff.
use super::diff::{Kind, Lines};
use std::ops::Range;
use std::sync::OnceLock;
use syntect::parsing::{ParseState, Scope, ScopeStack, ScopeStackOp, SyntaxReference, SyntaxSet};

/// What a stretch of code is, as far as its colour goes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Token {
    Comment,
    String,
    Number,
    Constant,
    Keyword,
    Type,
    Function,
}

/// A coloured stretch of a row's text, in bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Span {
    pub start: usize,
    pub end: usize,
    pub token: Token,
}

/// Bytes of a line coloured; the rest of a very long line stays plain.
const MAX_COLOURED_BYTES: usize = 2_000;
/// Lines of its hunk read before a stretch, unshown, so a string or
/// comment open across the seam colours right.
const WARM_UP: usize = 200;

/// The bundled grammars, loaded once, on the first diff that needs them.
fn syntaxes() -> &'static SyntaxSet {
    static SYNTAXES: OnceLock<SyntaxSet> = OnceLock::new();
    SYNTAXES.get_or_init(SyntaxSet::load_defaults_newlines)
}

/// Scope prefixes and what they mean, most specific first.
fn classes() -> &'static [(Scope, Token)] {
    static CLASSES: OnceLock<Vec<(Scope, Token)>> = OnceLock::new();
    CLASSES.get_or_init(|| {
        [
            ("comment", Token::Comment),
            ("string", Token::String),
            ("constant.character", Token::String),
            ("constant.numeric", Token::Number),
            ("entity.name.function", Token::Function),
            ("support.function", Token::Function),
            ("variable.function", Token::Function),
            ("entity.name.type", Token::Type),
            ("entity.name.class", Token::Type),
            ("entity.name.struct", Token::Type),
            ("entity.name.enum", Token::Type),
            ("entity.name.tag", Token::Type),
            // Words that introduce a definition read as keywords; other
            // storage types, such as `u32`, as types.
            ("storage.type.function", Token::Keyword),
            ("storage.type.struct", Token::Keyword),
            ("storage.type.enum", Token::Keyword),
            ("storage.type.trait", Token::Keyword),
            ("storage.type.impl", Token::Keyword),
            ("storage.type.class", Token::Keyword),
            ("storage.type.module", Token::Keyword),
            ("storage.type", Token::Type),
            ("support.type", Token::Type),
            ("support.class", Token::Type),
            ("keyword", Token::Keyword),
            ("storage", Token::Keyword),
            ("constant", Token::Constant),
            ("support.constant", Token::Constant),
        ]
        .into_iter()
        .filter_map(|(name, token)| Scope::new(name).ok().map(|scope| (scope, token)))
        .collect()
    })
}

/// The token the innermost classified scope gives, if any.
fn token(stack: &ScopeStack) -> Option<Token> {
    stack.as_slice().iter().rev().find_map(|scope| {
        classes()
            .iter()
            .find(|(prefix, _)| prefix.is_prefix_of(*scope))
            .map(|(_, token)| *token)
    })
}

/// One side of a file being read: its parser and open scopes.
struct Side {
    state: ParseState,
    stack: ScopeStack,
}

impl Side {
    fn new(syntax: &SyntaxReference) -> Self {
        Self {
            state: ParseState::new(syntax),
            stack: ScopeStack::new(),
        }
    }

    /// The spans of `text`, the next line on this side. A line Git or the
    /// grammar cannot follow just goes uncoloured.
    fn line(&mut self, text: &str) -> Vec<Span> {
        let mut end = text.len().min(MAX_COLOURED_BYTES);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        let text = &text[..end];
        let line = format!("{text}\n");
        let Ok(ops) = self.state.parse_line(&line, syntaxes()) else {
            return Vec::new();
        };
        let mut spans: Vec<Span> = Vec::new();
        let mut from = 0;
        let push = |spans: &mut Vec<Span>, start: usize, end: usize, stack: &ScopeStack| {
            let end = end.min(text.len());
            if start >= end {
                return;
            }
            let Some(token) = token(stack) else {
                return;
            };
            match spans.last_mut() {
                Some(last) if last.token == token && last.end == start => last.end = end,
                _ => spans.push(Span { start, end, token }),
            }
        };
        for (at, op) in ops {
            push(&mut spans, from, at, &self.stack);
            if apply(&mut self.stack, &op).is_err() {
                return spans;
            }
            from = at;
        }
        push(&mut spans, from, text.len(), &self.stack);
        spans
    }
}

fn apply(stack: &mut ScopeStack, op: &ScopeStackOp) -> Result<(), syntect::parsing::ScopeError> {
    stack.apply(op).map(|_| ())
}

/// The grammar for a file, by its extension.
fn grammar(name: &str) -> Option<&'static SyntaxReference> {
    let extension = std::path::Path::new(name).extension()?.to_str()?;
    syntaxes().find_syntax_by_extension(extension)
}

/// The spans of each line of `lines` in `range`, a stretch of one hunk,
/// for a file named `name`. Blocking: it runs on the background executor.
pub(crate) fn colour(name: &str, lines: &Lines, range: Range<usize>) -> Vec<Vec<Span>> {
    let Some(syntax) = grammar(name) else {
        return vec![Vec::new(); range.len()];
    };
    let (mut old, mut new) = (Side::new(syntax), Side::new(syntax));
    let mut read = |index: usize| {
        let Some(line) = lines.get(index) else {
            return Vec::new();
        };
        let text = lines.text_of(line);
        match line.kind {
            Kind::Added => new.line(text),
            Kind::Removed => old.line(text),
            Kind::Context => {
                old.line(text);
                new.line(text)
            }
            Kind::Hunk | Kind::Meta => Vec::new(),
        }
    };
    let warm = lines
        .hunk_start(range.start)
        .max(range.start.saturating_sub(WARM_UP));
    for index in warm..range.start {
        read(index);
    }
    range.map(read).collect()
}

#[cfg(test)]
mod tests;
