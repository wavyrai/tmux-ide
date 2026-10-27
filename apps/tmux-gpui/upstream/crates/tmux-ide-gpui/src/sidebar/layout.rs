//! Density and style policy shared by sidebar rows, headings, and their label
//! budgets. A layout name pairs one of each, so every density has a rounded
//! variant without a type per combination.

use super::{
    CHILD_INDENT, HOST_GAP, LABEL_GAP, ROW_PADDING, STATUS_WIDTH, cell::RowState, row::RowLift,
};
use crate::config::{Density, LayoutMode, SidebarOverrides, Style, Theme};
use gpui::{
    Div, InteractiveElement, ParentElement, Styled, div, prelude::FluentBuilder, px, rgb, rgba,
};

/// The spacing, indents, and highlight shape one layout name selects. A
/// preset fills every field; the config file may then override a few, so
/// these are plain values rather than per-preset types.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct SidebarMetrics {
    /// Horizontal padding inside a row's highlight.
    pub(crate) padding: f32,
    /// Space between a row's status dot and its label.
    pub(crate) gap: f32,
    /// Vertical padding the density adds around a row's text.
    pub(crate) row_padding: f32,
    /// How far a worktree row steps in under its repository.
    pub(crate) child_indent: f32,
    /// How far rows step in under a host header.
    pub(crate) nest: f32,
    /// How far the card layouts (superset, orca) step a worktree in: their
    /// own padding, unless an indent is configured.
    pub(crate) card_indent: f32,
    pub(crate) header_padding: f32,
    pub(crate) host_padding: f32,
    /// Space between a host header's parts: arrow, label, gauges, status.
    pub(crate) host_gap: f32,
    pub(crate) footer_padding: f32,
    pub(crate) workspace_details: bool,
    pub(crate) child_details: bool,
    pub(crate) pr_counts: bool,
    /// Horizontal space between the sidebar's edges and a row's highlight.
    pub(crate) inset: f32,
    /// Vertical space between neighbouring highlights, split above and below.
    pub(crate) spacing: f32,
    /// Vertical padding the style adds inside a row so text clears its
    /// highlight edge.
    pub(crate) style_padding: f32,
    pub(crate) radius: f32,
    pub(crate) highlight: Highlight,
    pub(crate) tree_lines: bool,
    pub(crate) header_case: HeaderCase,
}

impl SidebarMetrics {
    /// The density and style a layout name selects.
    pub(crate) fn for_mode(mode: LayoutMode) -> Self {
        let density = match mode.density() {
            Density::Comfortable => Self::comfortable(),
            Density::Normal => Self::normal(),
            Density::Compact => Self::compact(),
        };
        match mode.style() {
            Style::Flat => density,
            Style::Rounded => density.rounded(),
        }
    }

    const fn comfortable() -> Self {
        Self {
            padding: ROW_PADDING,
            gap: LABEL_GAP,
            row_padding: 4.,
            child_indent: CHILD_INDENT,
            nest: CHILD_INDENT,
            card_indent: ROW_PADDING,
            header_padding: 6.,
            host_padding: 8.,
            host_gap: HOST_GAP,
            footer_padding: 5.,
            workspace_details: true,
            child_details: true,
            pr_counts: true,
            ..Self::FLAT
        }
    }

    /// TUI-like density: branch lines on roots, single-line worktree
    /// children, and two-line agents without extra vertical padding.
    const fn normal() -> Self {
        let gap = 6.;
        Self {
            padding: 8.,
            gap,
            row_padding: 0.,
            child_indent: STATUS_WIDTH + gap + 8.,
            nest: STATUS_WIDTH + gap + 8.,
            card_indent: 8.,
            header_padding: 4.,
            host_padding: 2.,
            host_gap: HOST_GAP,
            footer_padding: 3.,
            workspace_details: true,
            child_details: false,
            pr_counts: false,
            ..Self::FLAT
        }
    }

    const fn compact() -> Self {
        let gap = 4.;
        Self {
            padding: 6.,
            gap,
            row_padding: 0.,
            child_indent: STATUS_WIDTH + gap + 8.,
            nest: STATUS_WIDTH + gap + 8.,
            card_indent: 6.,
            header_padding: 2.,
            host_padding: 0.,
            host_gap: HOST_GAP,
            footer_padding: 2.,
            workspace_details: false,
            child_details: false,
            pr_counts: false,
            ..Self::FLAT
        }
    }

    /// Edge-to-edge rows, square highlights, and tree lines tying worktrees
    /// to their repository. The spacing fields are placeholders a density
    /// fills in.
    const FLAT: Self = Self {
        padding: 0.,
        gap: 0.,
        row_padding: 0.,
        child_indent: 0.,
        nest: 0.,
        card_indent: 0.,
        header_padding: 0.,
        host_padding: 0.,
        host_gap: HOST_GAP,
        footer_padding: 0.,
        workspace_details: false,
        child_details: false,
        pr_counts: false,
        inset: 0.,
        spacing: 0.,
        style_padding: 0.,
        radius: 0.,
        highlight: Highlight::Fill,
        tree_lines: true,
        header_case: HeaderCase::Lower,
    };

    /// Inset rows with rounded, outlined highlights. Worktrees keep their
    /// indent but drop tree lines, which would break across the gaps
    /// between rows. Spacing scales with the density, so a compact rounded
    /// sidebar stays tighter than a normal one.
    fn rounded(self) -> Self {
        let trim = (self.gap / 3.).round();
        Self {
            inset: self.gap,
            spacing: 2. * trim,
            style_padding: trim,
            radius: crate::config::corners::CONTROL,
            highlight: Highlight::Outline,
            tree_lines: false,
            header_case: HeaderCase::Title,
            ..self
        }
    }

    /// The preset with every key the config file set written over it. The
    /// indent sets both nesting levels, so a tree keeps one rhythm.
    pub(crate) fn with(self, overrides: &SidebarOverrides) -> Self {
        Self {
            child_indent: overrides.indent.unwrap_or(self.child_indent),
            nest: overrides.indent.unwrap_or(self.nest),
            card_indent: overrides.indent.unwrap_or(self.card_indent),
            row_padding: overrides.row_padding.unwrap_or(self.row_padding),
            gap: overrides.gap.unwrap_or(self.gap),
            host_gap: overrides.host_gap.unwrap_or(self.host_gap),
            ..self
        }
    }

    pub(super) fn padding(&self) -> f32 {
        self.padding
    }
    pub(super) fn gap(&self) -> f32 {
        self.gap
    }
    pub(super) fn child_indent(&self) -> f32 {
        self.child_indent
    }
    pub(super) fn card_indent(&self) -> f32 {
        self.card_indent
    }
    pub(super) fn workspace_details(&self) -> bool {
        self.workspace_details
    }
    pub(super) fn child_details(&self) -> bool {
        self.child_details
    }
    pub(super) fn pr_counts(&self) -> bool {
        self.pr_counts
    }
    pub(super) fn header_padding(&self) -> f32 {
        self.header_padding
    }
    pub(super) fn host_padding(&self) -> f32 {
        self.host_padding
    }
    pub(super) fn host_gap(&self) -> f32 {
        self.host_gap
    }
    pub(super) fn footer_padding(&self) -> f32 {
        self.footer_padding
    }
    pub(super) fn tree_gutter(&self) -> f32 {
        self.padding + STATUS_WIDTH + self.gap
    }
}

/// How a focused or hovered row is marked.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Highlight {
    /// The theme's active color across the whole highlight.
    Fill,
    /// A faint foreground wash inside a brighter border, so the border carries
    /// the selection while the label stays legible.
    Outline,
}

/// How section headings spell their label.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HeaderCase {
    Lower,
    Title,
}

/// The metrics a layout name selects and the geometry derived from them.
/// Painting, hit testing, and label budgets all read these numbers.
#[derive(Clone, Copy)]
pub(super) struct SidebarLook {
    pub(super) density: SidebarMetrics,
}

/// Group every row joins, so its highlight layer can follow the row's hover.
/// GPUI resolves a group name to the innermost member, so rows can share it.
pub(super) const ROW_GROUP: &str = "sidebar-row";

impl SidebarLook {
    pub(super) fn inset(&self) -> f32 {
        self.density.inset
    }

    pub(super) fn spacing(&self) -> f32 {
        self.density.spacing
    }

    /// Vertical padding between a row's highlight edge and its text.
    pub(super) fn row_padding(&self) -> f32 {
        self.density.row_padding + self.density.style_padding
    }

    /// Where row content starts: the highlight's inset plus the density's own
    /// padding inside it. Headings and footers use it too, so they align.
    pub(super) fn content_x(&self) -> f32 {
        self.inset() + self.density.padding()
    }

    /// Width a row's contents can use, after both edges' insets and padding.
    /// The extra pixel is the sidebar's divider.
    pub(super) fn content_width(&self, width: f32) -> f32 {
        width - 1. - 2. * self.content_x()
    }

    /// A row's full height: its content, the padding around it, and its share
    /// of the spacing to the neighbouring rows.
    pub(super) fn row_height(&self, content: f32) -> f32 {
        content + 2. * self.density.row_padding + self.chrome_height()
    }

    /// Height the style adds around any row, the host rows included.
    pub(super) fn chrome_height(&self) -> f32 {
        2. * self.density.style_padding + self.spacing()
    }

    pub(super) fn tree_gutter(&self) -> f32 {
        self.inset() + self.density.tree_gutter()
    }

    /// How far rows step in under a host header, so a host reads as the
    /// parent of its workspaces the way a repository does of its worktrees.
    pub(super) fn nest_indent(&self) -> f32 {
        self.density.nest
    }

    pub(super) fn header_label(&self, label: &'static str) -> String {
        match self.density.header_case {
            HeaderCase::Lower => label.to_owned(),
            HeaderCase::Title => {
                let mut chars = label.chars();
                chars.next().map_or_else(String::new, |first| {
                    first.to_uppercase().chain(chars).collect()
                })
            }
        }
    }

    /// Joins `row` to the hover group its highlight follows.
    pub(super) fn hover_group<E: InteractiveElement>(&self, row: E) -> E {
        row.group(ROW_GROUP)
    }

    /// The layer a row paints its focus and hover highlight on. It is
    /// absolutely positioned, so a border or radius never changes the row's
    /// measured geometry, and it must be the row's first child so content
    /// paints above it.
    pub(super) fn highlight(&self, key: &str, state: RowState, theme: &Theme) -> Div {
        let RowState {
            selected: focused,
            highlighted,
            ..
        } = state;
        let inset = px(self.inset());
        let edge = px(self.spacing() / 2.);
        let layer = div()
            .debug_selector(|| format!("highlight-{key}"))
            .absolute()
            .left(inset)
            .right(inset)
            .top(edge)
            .bottom(edge)
            .rounded(px(self.density.radius));
        match self.density.highlight {
            Highlight::Fill => {
                let active = theme.active;
                layer
                    .when(focused || highlighted, |layer| layer.bg(rgb(active)))
                    .group_hover(ROW_GROUP, move |s| s.bg(rgb(active)))
            }
            Highlight::Outline => {
                let wash = |alpha: u32| rgba((theme.foreground << 8) | alpha);
                let (hover, selected, border) = (wash(0x0d), wash(0x14), wash(0x40));
                layer
                    .border_1()
                    .border_color(rgba(0))
                    .when(focused, |layer| layer.bg(selected).border_color(border))
                    .when(!focused && highlighted, |layer| layer.bg(hover))
                    .when(!focused, |layer| {
                        layer.group_hover(ROW_GROUP, move |s| s.bg(hover))
                    })
            }
        }
    }
}

impl SidebarLook {
    /// A row's state layer and hover wiring together: the lifted card while
    /// it is carried, and no hover while a carried row passes over it.
    pub(super) fn mark(&self, row: Div, key: &str, state: RowState, theme: &Theme) -> Div {
        match state.lift {
            RowLift::Resting => self
                .hover_group(row)
                .child(self.highlight(key, state, theme)),
            RowLift::Passed => row.child(self.highlight(key, state, theme)),
            RowLift::Lifted => row.child(self.lifted(key, state.selected, theme)),
        }
    }

    /// The highlight layer as a card carried over the list: opaque so the rows
    /// it passes stay hidden, shadowed rather than colored so it reads the same
    /// in every theme, and pulled in from edge-to-edge rows so it looks lifted.
    /// Only the layer changes, so the row's contents stay where they were.
    pub(super) fn lifted(&self, key: &str, focused: bool, theme: &Theme) -> Div {
        let inset = px(self.inset().max(LIFT_INSET));
        let edge = px(self.spacing() / 2.);
        let wash = |alpha: u32| rgba((theme.foreground << 8) | alpha);
        div()
            .debug_selector(|| format!("highlight-{key}"))
            .absolute()
            .left(inset)
            .right(inset)
            .top(edge)
            .bottom(edge)
            .rounded(px(self.density.radius.max(LIFT_RADIUS)))
            .bg(rgb(match self.density.highlight {
                Highlight::Fill if focused => theme.active,
                _ => theme.sidebar_background(),
            }))
            .when(self.density.highlight == Highlight::Outline, |card| {
                card.border_1()
                    .border_color(wash(if focused { 0x40 } else { 0x20 }))
            })
            .shadow_lg()
    }
}

/// How far a lifted card pulls in from rows that run edge to edge.
const LIFT_INSET: f32 = 6.;
/// The least rounding a lifted card gets, even from square rows.
const LIFT_RADIUS: f32 = 4.;

pub(super) fn for_mode(mode: LayoutMode) -> SidebarLook {
    SidebarLook {
        density: SidebarMetrics::for_mode(mode),
    }
}

/// The look a window's config asks for: its layout with its overrides.
pub(super) fn for_config(config: &crate::config::Config) -> SidebarLook {
    SidebarLook {
        density: SidebarMetrics::for_mode(config.layout.mode).with(&config.sidebar_style.overrides),
    }
}
