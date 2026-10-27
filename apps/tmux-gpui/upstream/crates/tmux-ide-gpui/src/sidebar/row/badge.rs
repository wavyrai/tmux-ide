//! The trailing badges a row reserves room for: its pull request, dirty,
//! note, and teleported marks, and the upstream drift counts.

use super::label_text;
use crate::{
    config::{FontConfig, Theme},
    sidebar::{glyph_width, layout::SidebarMetrics, line_height},
};
use gpui::{prelude::*, *};

/// What a row shows on its right edge: the cached pull request, and whether
/// the checkout has work that is not committed yet.
pub(in crate::sidebar) struct RowBadge {
    pub(in crate::sidebar) pr: Option<PrBadge>,
    pub(in crate::sidebar) dirty: bool,
    /// The work moved to another host; this checkout stays behind.
    pub(in crate::sidebar) teleported: bool,
    /// The user keeps a note on this checkout. Card layouts leave it to the
    /// note's own line under the row, which leads with the same icon, rather
    /// than squeeze their pull request number out of a narrow card.
    pub(in crate::sidebar) noted: bool,
}

impl RowBadge {
    pub(in crate::sidebar) fn lines(&self, layout: &SidebarMetrics) -> usize {
        1 + usize::from(self.pr.is_some() && layout.pr_counts())
    }

    /// Nothing to draw is nothing to reserve, so a row with none keeps its
    /// full label width.
    pub(in crate::sidebar) fn new(
        pr: Option<PrBadge>,
        dirty: bool,
        teleported: bool,
        noted: bool,
    ) -> Option<Self> {
        (pr.is_some() || dirty || teleported || noted).then_some(Self {
            pr,
            dirty,
            teleported,
            noted,
        })
    }

    pub(in crate::sidebar) fn width(&self, font: &FontConfig, layout: &SidebarMetrics) -> f32 {
        let pr = self.pr.as_ref().map_or(0., |pr| pr.width(font, layout));
        // Reserve the icon and the gap before the PR number, even at small fonts.
        let mark = line_height(font).min(18.) + glyph_width(font);
        let marks = [self.dirty, self.teleported, self.noted]
            .into_iter()
            .filter(|mark| *mark)
            .count();
        pr + mark * marks as f32
    }

    /// The badge column at a row's trailing edge, `width` wide: the marks and
    /// pull request number on the first line, its counts under them.
    pub(in crate::sidebar) fn element(
        self,
        key: &str,
        width: f32,
        font: &FontConfig,
        theme: &Theme,
        layout: &SidebarMetrics,
    ) -> Div {
        let Self {
            pr,
            dirty,
            teleported,
            noted,
        } = self;
        div()
            .debug_selector(|| format!("pr-{key}"))
            .w(px(width))
            .flex_none()
            .flex()
            .flex_col()
            .items_end()
            .overflow_hidden()
            .child(
                div()
                    .h(px(line_height(font)))
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap(px(glyph_width(font)))
                    .overflow_hidden()
                    // Uncommitted work, marked the way the titlebar
                    // button marks it: the counts beside it are the
                    // pull request's, not the working tree's.
                    .when(teleported, |line| {
                        line.child(
                            crate::icons::teleported(
                                theme,
                                (line_height(font) * 0.75).round().min(15.),
                            )
                            .debug_selector(|| format!("teleported-{key}")),
                        )
                    })
                    .when(noted, |line| {
                        line.child(
                            crate::icons::note(theme, (line_height(font) * 0.75).round().min(15.))
                                .debug_selector(|| format!("note-{key}")),
                        )
                    })
                    .when(dirty, |line| {
                        line.child(
                            // Well under the line height, so marks on
                            // neighbouring rows keep a visible gap.
                            crate::icons::uncommitted(
                                theme,
                                (line_height(font) * 0.75).round().min(15.),
                            )
                            .debug_selector(|| format!("dirty-{key}")),
                        )
                    })
                    .when_some(pr.as_ref(), |line, badge| {
                        line.child(
                            div()
                                .flex_none()
                                .truncate()
                                .text_color(rgb(badge.color))
                                .child(label_text(&badge.number)),
                        )
                    }),
            )
            .when_some(pr.filter(|_| layout.pr_counts()), |column, badge| {
                column.child(
                    div()
                        .flex()
                        .flex_none()
                        .overflow_hidden()
                        .child(
                            div()
                                .flex_none()
                                .text_color(rgb(theme.ink(theme.palette[2])))
                                .child(label_text(&badge.additions)),
                        )
                        .child(
                            div()
                                .flex_none()
                                .text_color(rgb(theme.muted))
                                .child(label_text("/")),
                        )
                        .child(
                            div()
                                .flex_none()
                                .text_color(rgb(theme.ink(theme.palette[1])))
                                .child(label_text(&badge.deletions)),
                        ),
                )
            })
    }
}

/// Cached pull request state for a worktree row: the number carries the
/// lifecycle/readiness color, the counts sit under it.
pub(in crate::sidebar) struct PrBadge {
    pub(in crate::sidebar) number: String,
    pub(in crate::sidebar) color: u32,
    pub(in crate::sidebar) additions: String,
    pub(in crate::sidebar) deletions: String,
}

impl PrBadge {
    pub(in crate::sidebar) fn new(pr: &crate::pull_request::PullRequest, theme: &Theme) -> Self {
        Self {
            number: format!("#{}", pr.number),
            color: pr.color(theme),
            additions: format!("+{}", compact(pr.additions)),
            deletions: format!("-{}", compact(pr.deletions)),
        }
    }

    /// Reserved width. Sidebar labels are monospace by default and digits are
    /// near-uniform elsewhere, so an em-fraction per glyph bounds both lines;
    /// a wider face truncates the counts rather than eating the label.
    pub(in crate::sidebar) fn width(&self, font: &FontConfig, layout: &SidebarMetrics) -> f32 {
        let mut glyphs = self.number.chars().count();
        if layout.pr_counts() {
            glyphs =
                glyphs.max(self.additions.chars().count() + self.deletions.chars().count() + 1);
        }
        (glyph_width(font) * glyphs as f32).ceil()
    }
}

/// How far the checked-out branch has drifted from its upstream, as the
/// daemon's `git_status` token reports it: `↑` commits to push in green, `↓`
/// commits to pull in red, painted the way the TUI paints them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::sidebar) struct Upstream {
    ahead: usize,
    behind: usize,
}

impl Upstream {
    /// Nothing while the branch is in sync, has no upstream, or the daemon's
    /// sidebar config leaves `git_status` out and so never computes it.
    pub(in crate::sidebar) fn new(counts: Option<(usize, usize)>) -> Option<Self> {
        let (ahead, behind) = counts?;
        (ahead > 0 || behind > 0).then_some(Self { ahead, behind })
    }

    /// `↑ahead` and `↓behind`, each only when nonzero.
    fn parts(self) -> impl Iterator<Item = (String, bool)> {
        [
            (self.ahead, '\u{2191}', true),
            (self.behind, '\u{2193}', false),
        ]
        .into_iter()
        .filter(|(count, _, _)| *count > 0)
        .map(|(count, arrow, ahead)| (format!("{arrow}{count}"), ahead))
    }

    /// Width at `glyph`, the two counts a glyph apart as in `↑2 ↓18`.
    pub(in crate::sidebar) fn width(self, glyph: f32) -> f32 {
        let (glyphs, parts) = self.parts().fold((0, 0), |(glyphs, parts), (text, _)| {
            (glyphs + text.chars().count(), parts + 1)
        });
        ((glyphs + parts - 1) as f32 * glyph).ceil()
    }

    pub(in crate::sidebar) fn element(self, key: &str, glyph: f32, theme: &Theme) -> Div {
        let (ahead, behind) = (theme.ink(theme.palette[2]), theme.ink(theme.palette[1]));
        div()
            .debug_selector(|| format!("upstream-{key}"))
            .w(px(self.width(glyph)))
            .flex_none()
            .flex()
            .gap(px(glyph))
            .overflow_hidden()
            .children(self.parts().map(|(text, is_ahead)| {
                div()
                    .flex_none()
                    .text_color(rgb(if is_ahead { ahead } else { behind }))
                    .child(label_text(&text))
            }))
    }
}

/// Four digits of churn is already a big diff; abbreviate past that so the
/// column stays narrow enough to leave the branch readable. The titlebar's Git
/// badge reuses it so one PR reads the same in both places.
pub(crate) fn compact(lines: u64) -> String {
    match lines {
        0..=9999 => lines.to_string(),
        _ => format!("{}k", lines / 1000),
    }
}
