//! Pieces row layouts are assembled from, and the [`Line`] that lays them out.
//!
//! A row does not let flexbox divide its width: shrinking text would take
//! its whole natural width first and push the pieces after it off the row.
//! A line measures its pieces instead:
//! fixed ones keep their size, shrinking ones take what they need up to a
//! share of the line, and filling ones split the rest. Every piece ends up
//! with an explicit width, so nothing can push past the row's edge.

use super::super::{
    cell::{RowContext, RowState},
    glyph_width, label_text, line_height,
    row::{self, PrBadge, RowLift, removing_dot},
    status_indicator,
    tokens::ResolvedToken,
};
use crate::config::{FontConfig, Theme};
use gpui::{prelude::*, *};
use herdr_client::protocol::AgentStatus;
use std::borrow::Cow;

/// How a piece claims its width.
#[derive(Clone, Copy)]
enum Fit {
    /// Exactly its natural width.
    Fixed,
    /// Its natural width, capped at this share of the line and at what is
    /// left once fixed pieces are placed.
    Shrink(f32),
    /// An equal part of whatever the other pieces leave.
    Fill,
}

enum Content<'a> {
    /// Ellipsized text, inset from its shell's edges by the given padding.
    Text(Cow<'a, str>, f32),
    Element(AnyElement),
    /// Nothing beyond the shell itself, which already holds its children.
    Shell,
    /// Built once the line knows the width the piece gets, for content such
    /// as configured token lines that budgets glyphs from it.
    Build(Box<dyn FnOnce(f32) -> Div + 'a>),
}

struct Piece<'a> {
    shell: Div,
    content: Content<'a>,
    natural: f32,
    fit: Fit,
}

/// A row of pieces with a known total width.
pub(super) struct Line<'a> {
    width: f32,
    gap: f32,
    pieces: Vec<Piece<'a>>,
}

impl FluentBuilder for Line<'_> {}

impl<'a> Line<'a> {
    pub(super) fn new(width: f32, gap: f32) -> Self {
        Self {
            width: width.max(0.),
            gap,
            pieces: Vec::new(),
        }
    }

    fn push(mut self, shell: Div, content: Content<'a>, natural: f32, fit: Fit) -> Self {
        self.pieces.push(Piece {
            shell,
            content,
            natural,
            fit,
        });
        self
    }

    /// An element that keeps `width` however short the line is. It is placed
    /// as is, so it must already be `width` wide.
    pub(super) fn fixed(self, width: f32, element: impl IntoElement) -> Self {
        let content = Content::Element(element.into_any_element());
        self.push(div(), content, width, Fit::Fixed)
    }

    /// A group that is clipped from the right when the line is short. The
    /// width applies to the group itself, so its bounds are what shows.
    pub(super) fn shrink(self, width: f32, group: Div) -> Self {
        self.push(group, Content::Shell, width, Fit::Shrink(1.))
    }

    /// Text sized to its content, up to `share` of the line. `glyph` is the
    /// width of one glyph at the size the shell sets.
    pub(super) fn label(
        self,
        shell: Div,
        text: impl Into<Cow<'a, str>>,
        glyph: f32,
        share: f32,
    ) -> Self {
        self.padded(shell, text, glyph, share, 0.)
    }

    /// A label whose shell pads it by `inset` on each side, such as a chip.
    pub(super) fn padded(
        self,
        shell: Div,
        text: impl Into<Cow<'a, str>>,
        glyph: f32,
        share: f32,
        inset: f32,
    ) -> Self {
        let text = text.into();
        let natural = (text.chars().count() as f32 * glyph).ceil() + 2. * inset;
        self.push(
            shell,
            Content::Text(text, inset),
            natural,
            Fit::Shrink(share),
        )
    }

    /// Text that takes the room the other pieces leave.
    pub(super) fn fill(self, shell: Div, text: impl Into<Cow<'a, str>>) -> Self {
        self.push(shell, Content::Text(text.into(), 0.), 0., Fit::Fill)
    }

    /// Content that takes the room the other pieces leave, built at that width.
    pub(super) fn fill_with(self, build: impl FnOnce(f32) -> Div + 'a) -> Self {
        self.push(div(), Content::Build(Box::new(build)), 0., Fit::Fill)
    }

    /// Empty room that pushes the pieces after it to the line's end.
    pub(super) fn spacer(self) -> Self {
        self.push(div(), Content::Shell, 0., Fit::Fill)
    }

    fn widths(&self) -> Vec<f32> {
        let gaps = self.gap * self.pieces.len().saturating_sub(1) as f32;
        let fixed: f32 = self
            .pieces
            .iter()
            .filter(|piece| matches!(piece.fit, Fit::Fixed))
            .map(|piece| piece.natural)
            .sum();
        let mut free = (self.width - gaps - fixed).max(0.);
        let mut widths: Vec<f32> = self
            .pieces
            .iter()
            .map(|piece| match piece.fit {
                Fit::Fixed => piece.natural,
                Fit::Shrink(share) => {
                    let width = piece.natural.min(share * self.width).min(free);
                    free -= width;
                    width
                }
                Fit::Fill => 0.,
            })
            .collect();
        let fills = self
            .pieces
            .iter()
            .filter(|piece| matches!(piece.fit, Fit::Fill))
            .count();
        if fills > 0 {
            let share = free / fills as f32;
            for (width, piece) in widths.iter_mut().zip(&self.pieces) {
                if matches!(piece.fit, Fit::Fill) {
                    *width = share;
                }
            }
        }
        widths
    }

    pub(super) fn into_div(self) -> Div {
        let widths = self.widths();
        let line = div()
            .w(px(self.width))
            .flex_none()
            .flex()
            .items_center()
            .gap(px(self.gap))
            .overflow_hidden();
        self.pieces
            .into_iter()
            .zip(widths)
            .fold(line, |line, (piece, width)| {
                // Each piece is one element: fixed ones are placed as their
                // callers sized them, and text ellipsizes in its own shell.
                if let Content::Element(element) = piece.content {
                    return line.child(element);
                }
                let shell = piece.shell.w(px(width)).flex_none().overflow_hidden();
                line.child(match piece.content {
                    Content::Text(text, inset) => {
                        shell.px(px(inset)).truncate().child(label_text(&text))
                    }
                    Content::Build(build) => shell.child(build(width)),
                    Content::Element(_) | Content::Shell => shell,
                })
            })
    }
}

/// Glyph width at `size`, scaled from the sidebar font's.
pub(super) fn glyph_at(font: &FontConfig, size: f32) -> f32 {
    glyph_width(font) * size / font.size
}

/// `color` at `alpha` out of 255, for washes laid over the sidebar surface.
pub(super) fn wash(color: u32, alpha: u8) -> Rgba {
    rgba((color << 8) | u32::from(alpha))
}

/// Marks a row by its state: `fill` while focused, `hover` under the pointer
/// or while highlighted. A carried row becomes an opaque card lifted by a
/// shadow, so the rows it floats over stay hidden in every theme; the rows it
/// passes stop answering hover, leaving the gap to mark where it lands.
pub(super) fn mark(row: Div, state: RowState, colors: (Rgba, Rgba), theme: &Theme) -> Div {
    let (fill, hover) = colors;
    let selected = state.selected;
    match state.lift {
        // Only a border the layout already draws is colored: adding one
        // would resize the row the list measured.
        RowLift::Lifted => row
            .bg(rgb(if selected {
                theme.active
            } else {
                theme.sidebar_background()
            }))
            .border_color(wash(theme.foreground, if selected { 0x40 } else { 0x20 }))
            .shadow_lg(),
        RowLift::Passed => row.when(selected, |row| row.bg(fill)),
        RowLift::Resting => row
            .when(selected, |row| row.bg(fill))
            .when(!selected && state.highlighted, |row| row.bg(hover))
            .when(!selected, |row| row.hover(move |style| style.bg(hover))),
    }
}

pub(super) fn icon(path: impl Into<SharedString>, size: f32, color: u32) -> Svg {
    svg()
        .path(path)
        .size(px(size))
        .flex_none()
        .text_color(rgb(color))
}

/// The status dot, or the pulse that replaces it while a checkout is deleted.
/// Unlike the Herdr row's, it carries no offset: a line centers it.
pub(super) fn status(status: AgentStatus, removing: bool, cx: &RowContext<'_>) -> Div {
    if removing {
        div()
            .w(px(cx.indicators.width(cx.font)))
            .flex_none()
            .flex()
            .justify_center()
            .child(removing_dot("worktree-removing", cx.theme))
    } else {
        status_indicator(status, cx.font, cx.indicators).mt_0()
    }
}

/// What a configured row shows in its status slot: the removal pulse, the
/// mark its leading `state_icon` styles, or nothing. Both sit on the first
/// line, so the slot suits a line whose pieces align to its top.
pub(super) fn configured_status(
    lines: &[Vec<ResolvedToken>],
    status: AgentStatus,
    removing: bool,
    cx: &RowContext<'_>,
) -> Option<Div> {
    if removing {
        return Some(first_line(
            cx.indicators.width(cx.font),
            self::status(status, true, cx),
            cx,
        ));
    }
    row::leading_status(lines).map(|token| row::configured_status(token, status, cx))
}

/// `element` centered in a box one line tall, for pieces beside a block of
/// configured lines that align to its first line.
pub(super) fn first_line(width: f32, element: impl IntoElement, cx: &RowContext<'_>) -> Div {
    div()
        .w(px(width))
        .h(px(line_height(cx.font)))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .child(element)
}

/// Uncommitted work, marked as the titlebar marks it.
pub(super) fn teleported(key: &str, size: f32, theme: &Theme) -> Div {
    crate::icons::teleported(theme, size).debug_selector(|| format!("teleported-{key}"))
}

pub(super) fn dirty(key: &str, size: f32, theme: &Theme) -> Div {
    crate::icons::uncommitted(theme, size).debug_selector(|| format!("dirty-{key}"))
}

/// The pull request's `+additions -deletions`, colored or muted, and the
/// width it needs at `glyph`.
pub(super) fn pr_counts(key: &str, pr: &PrBadge, glyph: f32, colors: (u32, u32)) -> (f32, Div) {
    let glyphs = pr.additions.chars().count() + pr.deletions.chars().count() + 1;
    let element = div()
        .debug_selector(|| format!("pr-{key}"))
        .flex()
        .gap(px(glyph))
        .child(
            div()
                .text_color(rgb(colors.0))
                .child(label_text(&pr.additions)),
        )
        .child(
            div()
                .text_color(rgb(colors.1))
                .child(label_text(&pr.deletions)),
        );
    ((glyphs as f32 * glyph).ceil(), element)
}

/// The pull request's number beside a branch mark, both in its state color,
/// and the width it needs at `size`.
pub(super) fn pr_number(key: &str, pr: &PrBadge, size: f32, glyph: f32) -> (f32, Div) {
    let element = div()
        .debug_selector(|| format!("pr-{key}"))
        .flex()
        .items_center()
        .gap(px(3.))
        .text_color(rgb(pr.color))
        .child(icon("icons/git-branch.svg", size, pr.color))
        .child(label_text(&pr.number));
    let width = size + 3. + (pr.number.chars().count() as f32 * glyph).ceil();
    (width, element)
}

/// Where an agent runs, as one muted label: host, workspace, and tab.
pub(super) fn agent_place<'a>(
    place: Option<(&'a str, Option<&'a str>)>,
    host: Option<&'a str>,
) -> Option<Cow<'a, str>> {
    let (workspace, tab) = place?;
    Some(match (host, tab) {
        (None, None) => Cow::Borrowed(workspace),
        (host, tab) => Cow::Owned(
            [host, Some(workspace), tab]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" \u{b7} "),
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::{Line, agent_place};
    use gpui::{Empty, div};
    use std::borrow::Cow;

    fn widths(line: Line<'_>) -> Vec<f32> {
        line.widths()
    }

    #[test]
    fn lines_give_fixed_pieces_their_size_and_share_the_rest() {
        // 100 wide, two 4px gaps: 92 to divide.
        let line = Line::new(100., 4.)
            .fixed(20., Empty)
            .fill(div(), "name")
            .label(div(), "12345", 2., 1.);
        assert_eq!(widths(line), vec![20., 62., 10.]);
    }

    #[test]
    fn short_lines_shrink_labels_before_fixed_pieces_and_never_go_negative() {
        let line = Line::new(30., 4.)
            .fixed(20., Empty)
            .fill(div(), "name")
            .label(div(), "1234567890", 2., 1.);
        assert_eq!(widths(line), vec![20., 0., 2.]);
        let line = Line::new(10., 4.).fixed(20., Empty).fill(div(), "name");
        assert_eq!(widths(line), vec![20., 0.]);
    }

    #[test]
    fn labels_stop_at_their_share_and_fills_split_evenly() {
        let line = Line::new(100., 0.)
            .label(div(), "x".repeat(80), 1., 0.5)
            .fill(div(), "a")
            .spacer();
        assert_eq!(widths(line), vec![50., 25., 25.]);
    }

    #[test]
    fn agents_join_their_place_only_when_there_is_more_than_a_workspace() {
        assert_eq!(agent_place(None, Some("remote")), None);
        assert!(matches!(
            agent_place(Some(("herdr", None)), None),
            Some(Cow::Borrowed("herdr"))
        ));
        assert_eq!(
            agent_place(Some(("herdr", Some("tab 2"))), Some("remote")).as_deref(),
            Some("remote \u{b7} herdr \u{b7} tab 2")
        );
    }
}
