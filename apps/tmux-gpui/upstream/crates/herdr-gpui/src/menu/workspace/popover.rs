//! The workspace popover: a header naming the workspace, a fixed grid of
//! large action tiles, plain rows for the rarer actions, the destructive
//! action set apart, and the pull request section below.

use crate::{
    HerdrWindow,
    menu::{WorkspaceAction, WorkspaceMenuAction, accent, danger},
};
use gpui::{prelude::*, *};

/// The grid's fixed slots, row by row: working on the checkout, then moving
/// or leaving it. A slot lists the actions it can show, first available
/// first, and the action it shows grayed when none is.
const SLOTS: [(&[WorkspaceMenuAction], WorkspaceMenuAction, &str); 6] = {
    use WorkspaceAction::*;
    use WorkspaceMenuAction::*;
    [
        (&[Dialog(NewWorktree)], Dialog(NewWorktree), "New worktree"),
        (&[FanOut], FanOut, "Fan out prompt..."),
        (&[Dialog(Rename)], Dialog(Rename), "Rename"),
        (&[GoToTeleported, Teleport], Teleport, "Teleport..."),
        (
            &[ClearTeleported, TeleportBack],
            TeleportBack,
            "Teleport back",
        ),
        (&[Dialog(Close)], Dialog(Close), "Close"),
    ]
};

const COLUMNS: usize = 3;

/// The rows under the grid share one icon column and one label column: the
/// same inset, a fixed icon slot each icon centres in whatever its size, and
/// the same gap before the label.
const ROW_INSET: f32 = 8.;
const ICON_SLOT: f32 = 20.;
const ICON_SIZE: f32 = 16.;
const ROW_GAP: f32 = 8.;

/// A row's leading icon, centred in the shared slot. An action without an
/// icon keeps the empty slot so its label still lines up.
fn leading_icon(action: WorkspaceMenuAction, label: &'static str, color: Rgba) -> Div {
    div()
        .size(px(ICON_SLOT))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .when_some(action.icon(), |slot, icon| {
            slot.child(
                svg()
                    .path(icon)
                    .size(px(ICON_SIZE))
                    .flex_none()
                    .text_color(color)
                    .debug_selector(move || format!("workspace-menu-icon-{label}")),
            )
        })
}

/// One grid cell: the action it runs, its menu label, and whether this
/// workspace can take it now. A grayed tile keeps the grid's shape stable.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::menu) struct Tile {
    pub(in crate::menu) action: WorkspaceMenuAction,
    pub(in crate::menu) label: &'static str,
    pub(in crate::menu) enabled: bool,
}

impl Tile {
    /// The tile's caption: the menu label, shortened where the tile's icon
    /// and position already say the rest.
    fn caption(self) -> &'static str {
        match self.action {
            WorkspaceMenuAction::FanOut if self.label.starts_with("Fan-out") => "Comparison",
            WorkspaceMenuAction::FanOut => "Fan out",
            WorkspaceMenuAction::GoToTeleported => "Go to copy",
            WorkspaceMenuAction::ClearTeleported => "Clear mark",
            _ => self.label.trim_end_matches("..."),
        }
    }
}

/// Lays `items` into the grid. Items no slot takes are returned in order,
/// for the rows beneath it.
pub(in crate::menu) fn layout(
    items: &[(WorkspaceMenuAction, &'static str)],
) -> ([Tile; 6], Vec<(WorkspaceMenuAction, &'static str)>) {
    let tiles = SLOTS.map(|(choices, fallback, label)| {
        choices
            .iter()
            .find_map(|choice| items.iter().find(|(action, _)| action == choice))
            .map_or(
                Tile {
                    action: fallback,
                    label,
                    enabled: false,
                },
                |&(action, label)| Tile {
                    action,
                    label,
                    enabled: true,
                },
            )
    });
    let rest = items
        .iter()
        .filter(|(action, _)| {
            !tiles
                .iter()
                .any(|tile| tile.enabled && tile.action == *action)
        })
        .copied()
        .collect();
    (tiles, rest)
}

impl HerdrWindow {
    pub(in crate::menu) fn render_workspace_popover(
        &self,
        pr_width: Pixels,
        cx: &mut Context<Self>,
    ) -> Div {
        let theme = &self.theme;
        let font = &self.config.ui;
        let mut panel = div().flex().flex_col();
        if let Some(target) = &self.menu.target {
            panel = panel.child(
                div()
                    .debug_selector(|| "workspace-menu-header".into())
                    .px(px(8.))
                    .py(px(6.))
                    .mb(px(4.))
                    .border_b_1()
                    .border_color(rgb(theme.active))
                    .child(
                        div()
                            .debug_selector(|| "workspace-menu-name".into())
                            .truncate()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(crate::sidebar::label_text(&target.label)),
                    )
                    .when_some(
                        target
                            .branch
                            .as_deref()
                            .filter(|branch| !branch.trim().is_empty()),
                        |header, branch| {
                            header.child(
                                div()
                                    .debug_selector(|| "workspace-menu-branch".into())
                                    .truncate()
                                    .text_color(rgb(theme.muted))
                                    .text_size(px(font.size * 0.9))
                                    .child(crate::sidebar::label_text(branch)),
                            )
                        },
                    ),
            );
        }
        let (tiles, rest) = layout(&self.workspace_items());
        let mut grid = div()
            .debug_selector(|| "workspace-menu-tiles".into())
            .flex()
            .flex_col()
            .gap(px(6.))
            .p(px(2.));
        for row in tiles.chunks(COLUMNS) {
            grid = grid.child(
                div()
                    .flex()
                    .gap(px(6.))
                    .children(row.iter().map(|tile| self.render_workspace_tile(*tile, cx))),
            );
        }
        panel = panel.child(grid);
        let delete = WorkspaceMenuAction::Dialog(WorkspaceAction::DeleteWorktree);
        let (rows, destructive): (Vec<_>, Vec<_>) =
            rest.into_iter().partition(|(action, _)| *action != delete);
        if !rows.is_empty() {
            panel = panel.child(div().h(px(6.)));
        }
        for (action, label) in rows {
            panel = panel.child(self.render_workspace_row(action, label, cx));
        }
        for (action, label) in destructive {
            panel = panel.child(self.render_workspace_danger(action, label, cx));
        }
        if self.pr_profile().is_some() {
            panel = panel.child(self.render_workspace_pr(pr_width, cx));
        }
        panel
    }

    /// Hover selects, as the arrow keys do, so both highlight the same item.
    fn workspace_hover(
        action: WorkspaceMenuAction,
        cx: &mut Context<Self>,
    ) -> impl Fn(&bool, &mut Window, &mut App) + 'static {
        cx.listener(move |this, hovered: &bool, _, cx| {
            if *hovered {
                this.menu.workspace_selected = Some(action);
            } else if this.menu.workspace_selected == Some(action) {
                this.menu.workspace_selected = None;
            }
            cx.notify();
        })
    }

    fn render_workspace_tile(&self, tile: Tile, cx: &mut Context<Self>) -> Stateful<Div> {
        let theme = &self.theme;
        let label = tile.label;
        let selected = tile.enabled && self.menu.workspace_selected == Some(tile.action);
        let primary = tile.action == WorkspaceMenuAction::Dialog(WorkspaceAction::NewWorktree);
        let ink = if primary && tile.enabled {
            accent(theme)
        } else {
            rgb(theme.foreground)
        };
        let resting = if primary && tile.enabled {
            Rgba { a: 0.16, ..ink }
        } else {
            rgb(theme.surface).blend(rgba((theme.foreground << 8) | 0x0f))
        };
        div()
            .id(label)
            .debug_selector(move || format!("workspace-menu-{label}"))
            .flex_1()
            .min_w_0()
            .min_h(px(64.))
            .px(px(4.))
            .py(px(10.))
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(6.))
            .rounded(px(crate::config::corners::CONTROL))
            .bg(if selected { rgb(theme.active) } else { resting })
            .text_color(ink)
            .text_size(px((self.config.ui.size - 1.).max(8.)))
            .when_some(tile.action.icon(), |tile_div, icon| {
                tile_div.child(
                    svg()
                        .path(icon)
                        .size(px(20.))
                        .flex_none()
                        .text_color(ink)
                        .debug_selector(move || format!("workspace-menu-icon-{label}")),
                )
            })
            .child(
                div()
                    .debug_selector(move || format!("workspace-menu-label-{label}"))
                    .max_w_full()
                    .truncate()
                    .child(tile.caption()),
            )
            .map(|tile_div| {
                if !tile.enabled {
                    return tile_div.opacity(0.4);
                }
                let action = tile.action;
                tile_div
                    .cursor_pointer()
                    .on_hover(Self::workspace_hover(action, cx))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        cx.stop_propagation();
                        this.activate_workspace_menu(action, window, cx);
                    }))
            })
    }

    /// A rarer action, as a plain row. Its icon leads, in the same column as
    /// the destructive strip's, so the rows read as one list under the tiles.
    fn render_workspace_row(
        &self,
        action: WorkspaceMenuAction,
        label: &'static str,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let theme = &self.theme;
        let selected = Some(action) == self.menu.workspace_selected;
        div()
            .id(label)
            .debug_selector(move || format!("workspace-menu-{label}"))
            .mx(px(2.))
            .min_h(px(self.config.ui.line_height() + 12.))
            .px(px(ROW_INSET))
            .flex()
            .items_center()
            .gap(px(ROW_GAP))
            .cursor_pointer()
            .rounded(px(crate::config::corners::CONTROL))
            .when(selected, |row| row.bg(rgb(theme.active)))
            .on_hover(Self::workspace_hover(action, cx))
            .child(leading_icon(
                action,
                label,
                rgb(if selected {
                    theme.foreground
                } else {
                    theme.muted
                }),
            ))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .debug_selector(move || format!("workspace-menu-label-{label}"))
                    .child(label),
            )
            .on_click(cx.listener(move |this, _, window, cx| {
                cx.stop_propagation();
                this.activate_workspace_menu(action, window, cx);
            }))
    }

    /// The destructive action, full width and red, apart from the tiles so it
    /// never reads as one more of them.
    fn render_workspace_danger(
        &self,
        action: WorkspaceMenuAction,
        label: &'static str,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let theme = &self.theme;
        let red = danger(theme);
        let selected = Some(action) == self.menu.workspace_selected;
        div()
            .id(label)
            .debug_selector(move || format!("workspace-menu-{label}"))
            .mt(px(6.))
            .mx(px(2.))
            .min_h(px(self.config.ui.line_height() + 12.))
            .px(px(ROW_INSET))
            .flex()
            .items_center()
            .gap(px(ROW_GAP))
            .cursor_pointer()
            .rounded(px(crate::config::corners::CONTROL))
            .bg(Rgba {
                a: if selected { 0.26 } else { 0.12 },
                ..red
            })
            .text_color(red)
            .on_hover(Self::workspace_hover(action, cx))
            .child(leading_icon(action, label, red))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .debug_selector(move || format!("workspace-menu-label-{label}"))
                    .child(label),
            )
            .on_click(cx.listener(move |this, _, window, cx| {
                cx.stop_propagation();
                this.activate_workspace_menu(action, window, cx);
            }))
    }
}
