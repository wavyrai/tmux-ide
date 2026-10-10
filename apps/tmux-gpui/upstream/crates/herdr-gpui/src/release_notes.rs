//! Daemon release notes and product announcements, prepared for display.
//!
//! Both arrive from the daemon as Markdown-flavored text, which is untrusted:
//! it is bounded, stripped of control and bidirectional override characters,
//! and only ever drawn as text. Links become clickable ranges that open in the
//! browser on click, and only `http`/`https` targets qualify. Commands shown in
//! code spans or blocks are never run.
use crate::{
    config::{FontConfig, Theme},
    fonts::StyledFont,
    notifications::safe_text,
};
use gpui::{prelude::*, *};
use std::{cell::RefCell, ops::Range, rc::Rc};

/// Scanned bytes of a body; a longer body is cut at a character boundary.
const MAX_BODY: usize = 64 * 1024;
const MAX_LINES: usize = 400;
const MAX_LINE: usize = 2000;
const MAX_URL: usize = 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    Heading,
    Bullet,
    Paragraph,
    /// A line inside a fenced code block, drawn verbatim in the terminal font.
    Code,
    Blank,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Link {
    pub range: Range<usize>,
    pub url: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Line {
    pub kind: Kind,
    pub text: String,
    /// Byte ranges of inline code spans in `text`.
    pub code: Vec<Range<usize>>,
    /// Byte ranges of `**strong**` spans in `text`.
    pub bold: Vec<Range<usize>>,
    pub links: Vec<Link>,
}

impl Line {
    fn plain(kind: Kind, text: String) -> Self {
        Self {
            kind,
            text,
            code: Vec::new(),
            bold: Vec::new(),
            links: Vec::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mark {
    Code,
    Bold,
    Link,
}

impl Line {
    /// Styled ranges in text order, as styled text runs require.
    fn highlights(&self) -> impl Iterator<Item = (Range<usize>, Mark)> {
        let mut ranges: Vec<_> = self
            .code
            .iter()
            .map(|range| (range.clone(), Mark::Code))
            .chain(self.bold.iter().map(|range| (range.clone(), Mark::Bold)))
            .chain(
                self.links
                    .iter()
                    .map(|link| (link.range.clone(), Mark::Link)),
            )
            .collect();
        ranges.sort_by_key(|(range, _)| range.start);
        ranges.into_iter()
    }
}

/// The lines of the last body drawn, so a repaint draws from prepared lines
/// instead of parsing the body again.
#[derive(Default)]
pub(crate) struct Prepared(RefCell<Option<(String, Rc<[Line]>)>>);

impl Prepared {
    pub(crate) fn lines(&self, body: &str) -> Rc<[Line]> {
        let mut cached = self.0.borrow_mut();
        if let Some((drawn, lines)) = cached.as_ref()
            && drawn == body
        {
            return lines.clone();
        }
        let lines: Rc<[Line]> = parse(body).into();
        *cached = Some((body.to_owned(), lines.clone()));
        lines
    }
}

/// Prepared daemon text for the announcement card and the release notes sheet.
#[derive(Default)]
pub(crate) struct DaemonText {
    pub announcement: Prepared,
    pub release_notes: Prepared,
}

/// Bounded, display-safe lines of a daemon-provided body.
pub(crate) fn parse(body: &str) -> Vec<Line> {
    let mut end = body.len().min(MAX_BODY);
    while !body.is_char_boundary(end) {
        end -= 1;
    }
    let mut lines = Vec::new();
    let mut fenced = false;
    for raw in body[..end].lines().take(MAX_LINES) {
        let trimmed = raw.trim_end();
        if trimmed.trim_start().starts_with("```") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            lines.push(Line::plain(Kind::Code, safe_text(trimmed, MAX_LINE)));
            continue;
        }
        let trimmed = trimmed.trim_start();
        if trimmed.is_empty() {
            // Runs of blank lines read as one paragraph break.
            if lines
                .last()
                .is_some_and(|line: &Line| line.kind != Kind::Blank)
            {
                lines.push(Line::plain(Kind::Blank, String::new()));
            }
            continue;
        }
        let heading = trimmed.trim_start_matches('#');
        let (kind, rest) = if heading.len() < trimmed.len() && heading.starts_with(' ') {
            (Kind::Heading, heading.trim())
        } else if let Some(rest) = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
        {
            (Kind::Bullet, rest)
        } else {
            (Kind::Paragraph, trimmed)
        };
        let safe = safe_text(rest, MAX_LINE);
        if kind == Kind::Heading {
            lines.push(Line::plain(kind, safe));
        } else {
            lines.push(inline(kind, &safe));
        }
    }
    while lines.last().is_some_and(|line| line.kind == Kind::Blank) {
        lines.pop();
    }
    lines
}

/// Inline code spans, `**strong**` text, `[label](url)` links, and bare URLs.
fn inline(kind: Kind, text: &str) -> Line {
    let mut line = Line::plain(kind, String::with_capacity(text.len()));
    let mut rest = text;
    while !rest.is_empty() {
        if let Some(after) = rest.strip_prefix('`')
            && let Some(close) = after.find('`')
        {
            let start = line.text.len();
            line.text.push_str(&after[..close]);
            line.code.push(start..line.text.len());
            rest = &after[close + 1..];
            continue;
        }
        if let Some(after) = rest.strip_prefix("**")
            && let Some(close) = after.find("**")
            && flanked(&after[..close])
        {
            let start = line.text.len();
            line.text.push_str(&after[..close]);
            line.bold.push(start..line.text.len());
            rest = &after[close + 2..];
            continue;
        }
        if let Some((label, url, consumed)) = markdown_link(rest) {
            let start = line.text.len();
            line.text.push_str(label);
            line.links.push(Link {
                range: start..line.text.len(),
                url: url.into(),
            });
            rest = &rest[consumed..];
            continue;
        }
        if let Some(url) = bare_url(rest) {
            let start = line.text.len();
            line.text.push_str(url);
            line.links.push(Link {
                range: start..line.text.len(),
                url: url.into(),
            });
            rest = &rest[url.len()..];
            continue;
        }
        let Some(next) = rest.chars().next() else {
            break;
        };
        line.text.push(next);
        rest = &rest[next.len_utf8()..];
    }
    line
}

/// Strong text hugs its markers, so stray asterisks stay literal.
fn flanked(content: &str) -> bool {
    !content.is_empty()
        && !content.starts_with(|c: char| c.is_whitespace() || c == '*')
        && !content.ends_with(char::is_whitespace)
}

/// `[label](url)` at the start of `text`: its label, URL, and length in bytes.
fn markdown_link(text: &str) -> Option<(&str, &str, usize)> {
    let after = text.strip_prefix('[')?;
    let close = after.find("](")?;
    let label = &after[..close];
    if label.is_empty() || label.contains(['[', ']']) {
        return None;
    }
    let target = &after[close + 2..];
    let end = target.find(')')?;
    let url = valid_url(&target[..end])?;
    Some((label, url, 1 + close + 2 + end + 1))
}

/// A bare URL at the start of `text`, without trailing sentence punctuation.
fn bare_url(text: &str) -> Option<&str> {
    if !(text.starts_with("https://") || text.starts_with("http://")) {
        return None;
    }
    let end = text.find(char::is_whitespace).unwrap_or(text.len());
    let url = text[..end].trim_end_matches(['.', ',', ';', ':', '!', '?', ')', '\'', '"', '>']);
    valid_url(url)
}

/// Only web links open, and only ones a browser can take verbatim.
fn valid_url(url: &str) -> Option<&str> {
    let host = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    (url.len() <= MAX_URL
        && !host.is_empty()
        && !host.starts_with(['/', '?', '#'])
        && !url.chars().any(|c| c.is_whitespace() || c.is_control()))
    .then_some(url)
}

/// Draws prepared lines. Each link opens in the browser only when clicked.
pub(crate) fn render(id: &'static str, lines: &[Line], theme: &Theme, mono: &FontConfig) -> Div {
    let accent = theme.ink(theme.palette[4]);
    div()
        .flex()
        .flex_col()
        .gap(px(2.))
        .min_w_0()
        .children(lines.iter().enumerate().map(|(index, line)| {
            let row = div()
                .debug_selector(move || format!("{id}-line-{index}"))
                .min_w_0();
            match line.kind {
                Kind::Blank => row.h(px(6.)),
                Kind::Heading => row
                    .pt(px(4.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(rgb(theme.primary()))
                    .child(line.text.clone()),
                Kind::Code => row
                    .px(px(8.))
                    .bg(rgb(theme.active))
                    .text_font(mono)
                    .whitespace_nowrap()
                    .overflow_hidden()
                    .child(line.text.clone()),
                Kind::Bullet => row
                    .flex()
                    .gap(px(6.))
                    .child(div().flex_none().text_color(rgb(accent)).child("•"))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(rich(id, index, line, theme, accent)),
                    ),
                Kind::Paragraph => row.child(rich(id, index, line, theme, accent)),
            }
        }))
}

fn rich(id: &'static str, index: usize, line: &Line, theme: &Theme, accent: u32) -> AnyElement {
    let code = HighlightStyle {
        color: Some(rgb(theme.foreground).into()),
        background_color: Some(rgb(theme.active).into()),
        ..Default::default()
    };
    let bold = HighlightStyle {
        font_weight: Some(FontWeight::SEMIBOLD),
        ..Default::default()
    };
    let link = HighlightStyle {
        color: Some(rgb(accent).into()),
        underline: Some(UnderlineStyle {
            thickness: px(1.),
            ..Default::default()
        }),
        ..Default::default()
    };
    let highlights = line.highlights().map(|(range, mark)| {
        let style = match mark {
            Mark::Code => code,
            Mark::Bold => bold,
            Mark::Link => link,
        };
        (range, style)
    });
    let text = StyledText::new(line.text.clone()).with_highlights(highlights);
    if line.links.is_empty() {
        return text.into_any_element();
    }
    let urls: Vec<String> = line.links.iter().map(|item| item.url.clone()).collect();
    InteractiveText::new((id, index), text)
        .on_click(
            line.links.iter().map(|item| item.range.clone()).collect(),
            move |clicked, _, cx| {
                if let Some(url) = urls.get(clicked) {
                    cx.open_url(url);
                }
            },
        )
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(lines: &[Line]) -> Vec<Kind> {
        lines.iter().map(|line| line.kind).collect()
    }

    #[core::prelude::v1::test]
    fn markdown_structure_becomes_typed_lines() {
        let lines =
            parse("### Added\n\n\n- New `herdr x` flag\nPlain text\n```\nrun --this\n```\n\n");
        assert_eq!(
            kinds(&lines),
            [
                Kind::Heading,
                Kind::Blank,
                Kind::Bullet,
                Kind::Paragraph,
                Kind::Code,
            ]
        );
        assert_eq!(lines[0].text, "Added");
        assert_eq!(lines[2].text, "New herdr x flag");
        assert_eq!(&lines[2].text[lines[2].code[0].clone()], "herdr x");
        assert_eq!(lines[4].text, "run --this");
        assert!(lines[4].links.is_empty() && lines[4].code.is_empty());
    }

    #[core::prelude::v1::test]
    fn only_web_links_become_clickable() {
        let line = &parse(
            "See [docs](https://herdr.dev/a?b=1) or https://example.com/x). \
             [bad](javascript:alert(1)) file:///etc/passwd [x](http://) `https://in.code`",
        )[0];
        let urls: Vec<_> = line.links.iter().map(|link| link.url.as_str()).collect();
        assert_eq!(urls, ["https://herdr.dev/a?b=1", "https://example.com/x"]);
        assert_eq!(&line.text[line.links[0].range.clone()], "docs");
        assert!(line.text.contains("[bad](javascript:alert(1))"));
        assert!(line.text.contains("file:///etc/passwd"));
        assert_eq!(&line.text[line.code[0].clone()], "https://in.code");
    }

    #[core::prelude::v1::test]
    fn highlights_are_in_text_order() {
        let line = &parse("[a](https://a.example) `b` https://c.example **d**")[0];
        let starts: Vec<_> = line
            .highlights()
            .map(|(range, mark)| (range.start, mark))
            .collect();
        assert_eq!(
            starts,
            [
                (0, Mark::Link),
                (2, Mark::Code),
                (4, Mark::Link),
                (22, Mark::Bold)
            ]
        );
        assert_eq!(line.text, "a b https://c.example d");
    }

    #[core::prelude::v1::test]
    fn controls_and_bidi_overrides_are_stripped() {
        let lines =
            parse("- \u{1b}[31mred\u{7} \u{202e}txt\u{2066}\r\n```\n\u{1b}]52;c;x\u{7}\n```");
        assert_eq!(lines[0].text, "[31mred txt");
        assert_eq!(lines[1].text, "]52;c;x");
    }

    #[core::prelude::v1::test]
    fn bodies_are_bounded() {
        let body = "x\n".repeat(MAX_LINES * 2);
        assert_eq!(parse(&body).len(), MAX_LINES);
        let long = "é".repeat(MAX_BODY);
        let lines = parse(&long);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].text.chars().count(), MAX_LINE);
        let url = format!("https://example.com/{}", "a".repeat(MAX_URL));
        assert!(parse(&url)[0].links.is_empty());
    }

    #[core::prelude::v1::test]
    fn prepared_lines_follow_the_body() {
        let prepared = Prepared::default();
        let first = prepared.lines("- one");
        assert!(Rc::ptr_eq(&first, &prepared.lines("- one")));
        assert_eq!(prepared.lines("- two")[0].text, "two");
    }

    #[core::prelude::v1::test]
    fn unmatched_markers_stay_literal() {
        let line = &parse("a `b [c](d e **** **f")[0];
        assert_eq!(line.text, "a `b [c](d e **** **f");
        assert!(line.code.is_empty() && line.bold.is_empty() && line.links.is_empty());
    }
}
