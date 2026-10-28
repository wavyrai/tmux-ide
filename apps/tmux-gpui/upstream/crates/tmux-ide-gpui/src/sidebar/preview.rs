//! Settings samples use the real row layouts, but own no connection or preferences.
use super::{
    Indicators,
    cell::{AgentRow, Cell, ClickHandler, Fold, RowContext, RowData, WorkspaceRow, layout_for},
    layout,
    row::{PrBadge, RowBadge, RowIcon, RowTree},
};
use crate::{
    config::{FontConfig, LayoutMode, Theme},
    fonts::StyledFont,
    icons::AgentIcon,
};
use gpui::{prelude::*, *};
use herdr_client::protocol::{AgentStatus, ClientShellWorkspace};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Target {
    Workspace(usize),
    Agent(usize),
}

const AGENTS: [(&str, AgentIcon, AgentStatus); 4] = [
    ("Claude", AgentIcon::Claude, AgentStatus::Working),
    ("OpenCode", AgentIcon::OpenCode, AgentStatus::Blocked),
    ("Codex", AgentIcon::Codex, AgentStatus::Done),
    ("Gemini", AgentIcon::Gemini, AgentStatus::Idle),
];

pub(crate) struct Preview {
    width: u16,
    selected: Target,
    folded: bool,
    workspaces: Vec<ClientShellWorkspace>,
}

impl Default for Preview {
    fn default() -> Self {
        let workspaces = [
            ("herdr-gpui", "main", AgentStatus::Idle),
            (
                "Settings window",
                "feat/settings-layout-chooser",
                AgentStatus::Working,
            ),
            (
                "fix/sidebar-long-branch-label-clipping",
                "worktree/fix/sidebar-long-branch-label-clipping",
                AgentStatus::Blocked,
            ),
            ("docs-site", "main", AgentStatus::Done),
            ("api-service", "main", AgentStatus::Working),
            ("release-tools", "main", AgentStatus::Idle),
        ]
        .into_iter()
        .enumerate()
        .map(|(index, (label, branch, status))| ClientShellWorkspace {
            workspace_id: format!("preview-{index}"),
            active_tab_id: String::new(),
            new_workspace_cwd: String::new(),
            number: index + 1,
            label: label.into(),
            custom_label: index == 1,
            branch: Some(branch.into()),
            git_ahead_behind: None,
            tokens: Vec::new(),
            worktree: None,
            focused: false,
            agent_status: status,
        })
        .collect();
        Self {
            width: 280,
            selected: Target::Workspace(1),
            folded: false,
            workspaces,
        }
    }
}

impl Preview {
    pub(crate) const WIDTHS: [u16; 3] = [240, 280, 320];

    pub(crate) fn width(&self) -> u16 {
        self.width
    }

    pub(crate) fn set_width(&mut self, width: u16) {
        if Self::WIDTHS.contains(&width) {
            self.width = width;
        }
    }

    pub(crate) fn select(&mut self, target: Target) {
        let visible = match target {
            Target::Workspace(index) => {
                index < self.workspaces.len() && !(self.folded && matches!(index, 1 | 2))
            }
            Target::Agent(index) => index < AGENTS.len(),
        };
        if visible {
            self.selected = target;
        }
    }

    pub(crate) fn toggle_fold(&mut self) {
        self.folded = !self.folded;
        if self.folded && matches!(self.selected, Target::Workspace(1 | 2)) {
            self.selected = Target::Workspace(0);
        }
    }

    pub(crate) fn render(
        &self,
        mode: LayoutMode,
        font: &FontConfig,
        theme: &Theme,
        indicators: Indicators,
        toggle_fold: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
        select: impl Fn(Target) -> Box<ClickHandler>,
    ) -> Stateful<Div> {
        let look = layout::for_mode(mode);
        let context = RowContext {
            indicators,
            font,
            theme,
            look,
            width: f32::from(self.width),
            nest: 0.,
            mark: Default::default(),
            host: None,
        };
        let rows = layout_for(mode);
        let heading = |label| {
            div()
                .flex_none()
                .px(px(look.content_x()))
                .py_2()
                .text_color(rgb(theme.muted))
                .child(look.header_label(label))
        };
        let mut spaces = div()
            .id("preview-spaces")
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .overflow_y_scroll();
        let mut fold = Some(Fold {
            id: "preview-fold".into(),
            index: 0,
            collapsed: self.folded,
            toggle: Box::new(toggle_fold),
        });
        for (index, workspace) in self.workspaces.iter().enumerate() {
            if self.folded && matches!(index, 1 | 2) {
                continue;
            }
            spaces = spaces.child(
                Cell::new(
                    rows,
                    RowData::Workspace(WorkspaceRow {
                        workspace,
                        label: &workspace.label,
                        tree: match index {
                            1 => RowTree::Child,
                            2 => RowTree::LastChild,
                            _ => RowTree::None,
                        },
                        icon: if matches!(index, 1 | 2) {
                            RowIcon::None
                        } else {
                            RowIcon::Mark
                        },
                        fold: if index == 0 { fold.take() } else { None },
                        grouped: index < 3,
                        badge: (index < 3).then(|| RowBadge {
                            pr: Some(PrBadge {
                                number: "#128".into(),
                                color: theme.primary(),
                                additions: "+84".into(),
                                deletions: "-12".into(),
                            }),
                            dirty: false,
                            teleported: false,
                            noted: false,
                        }),
                        removing: false,
                        status: workspace.agent_status,
                        lines: Vec::new(),
                    }),
                    &context,
                )
                .selected(self.selected == Target::Workspace(index))
                .row()
                .id(("preview-workspace", index))
                .on_click(select(Target::Workspace(index))),
            );
        }
        let mut agents = div()
            .id("preview-agents")
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .overflow_y_scroll();
        for (index, (name, icon, status)) in AGENTS.into_iter().enumerate() {
            agents = agents.child(
                Cell::new(
                    rows,
                    RowData::Agent(AgentRow {
                        key: format!("preview-agent-{index}"),
                        name,
                        icon,
                        status,
                        place: Some((&self.workspaces[index % 3].label, None)),
                        status_text: None,
                        lines: Vec::new(),
                    }),
                    &context,
                )
                .selected(self.selected == Target::Agent(index))
                .row()
                .id(("preview-agent", index))
                .on_click(select(Target::Agent(index))),
            );
        }
        div()
            .id("sidebar-preview")
            .debug_selector(|| "sidebar-preview".into())
            .w(px(f32::from(self.width)))
            .h(px(440.))
            .flex_none()
            .overflow_hidden()
            .flex()
            .flex_col()
            .border_r_1()
            .border_color(rgb(theme.active))
            .bg(rgb(theme.sidebar_background()))
            .text_color(rgb(theme.foreground))
            .text_font(font)
            .text_size(px(font.size))
            .line_height(px(super::line_height(font)))
            .child(
                div()
                    .h(px(246.))
                    .flex_none()
                    .flex()
                    .flex_col()
                    .child(heading("spaces"))
                    .child(spaces),
            )
            .child(heading("agents"))
            .child(agents)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use core::prelude::v1::test;

    struct Fixture {
        preview: Preview,
        mode: LayoutMode,
        font: FontConfig,
        theme: Theme,
    }

    impl Render for Fixture {
        fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            self.preview.render(
                self.mode,
                &self.font,
                &self.theme,
                Indicators::new(None, false, &self.theme),
                cx.listener(|this, _, _, cx| {
                    this.preview.toggle_fold();
                    cx.notify();
                }),
                |target| {
                    Box::new(cx.listener(move |this, _, _, cx| {
                        this.preview.select(target);
                        cx.notify();
                    }))
                },
            )
        }
    }

    #[test]
    fn sample_controls_are_bounded_and_keep_selection_visible() {
        let mut preview = Preview::default();
        let samples = preview.workspaces.clone();
        preview.set_width(999);
        assert_eq!(preview.width(), 280);
        preview.toggle_fold();
        assert_eq!(preview.selected, Target::Workspace(0));
        for target in [
            Target::Workspace(1),
            Target::Workspace(2),
            Target::Workspace(999),
            Target::Agent(999),
        ] {
            preview.select(target);
            assert_eq!(preview.selected, Target::Workspace(0));
        }
        preview.toggle_fold();
        for index in 0..samples.len() {
            preview.select(Target::Workspace(index));
            assert_eq!(preview.selected, Target::Workspace(index));
        }
        for index in 0..AGENTS.len() {
            preview.select(Target::Agent(index));
            assert_eq!(preview.selected, Target::Agent(index));
        }
        assert_eq!(preview.workspaces, samples);
    }

    #[gpui::test]
    fn all_layouts_and_widths_use_real_bounded_rows(cx: &mut TestAppContext) {
        let mut heights = Vec::new();
        for mode in LayoutMode::ALL {
            let (view, cx) = cx.add_window_view(|_, _| Fixture {
                preview: Preview::default(),
                mode,
                font: crate::config::Config::default().sidebar,
                theme: Theme::default(),
            });
            for width in Preview::WIDTHS {
                view.update(cx, |view, cx| {
                    view.preview.set_width(width);
                    cx.notify();
                });
                cx.update(|window, cx| super::super::layout_tests::full_draw(window, cx).clear(cx));
                let panel = cx.debug_bounds("sidebar-preview").unwrap();
                assert_eq!(panel.size, size(px(f32::from(width)), px(440.)));
                for (name, selector) in [
                    ("row-herdr-gpui", "name-herdr-gpui"),
                    ("row-Settings window", "name-Settings window"),
                    (
                        "row-fix/sidebar-long-branch-label-clipping",
                        "name-fix/sidebar-long-branch-label-clipping",
                    ),
                ] {
                    let row = cx.debug_bounds(name).unwrap();
                    let label = cx.debug_bounds(selector).unwrap();
                    assert!(label.left() >= row.left(), "{mode}: {name}");
                    assert!(label.right() <= row.right(), "{mode}: {name}");
                    assert!(row.right() <= panel.right());
                }
                assert!(cx.debug_bounds("row-preview-agent-0").is_some());
                assert_eq!(
                    cx.debug_bounds("pr-Settings window").is_some(),
                    mode != LayoutMode::Minimal
                );
                let branch_visible = match mode {
                    LayoutMode::Classic { density, .. } => {
                        density != crate::config::Density::Compact
                    }
                    LayoutMode::Orca => true,
                    LayoutMode::Superset | LayoutMode::Minimal => false,
                };
                assert_eq!(
                    cx.debug_bounds("detail-herdr-gpui").is_some(),
                    branch_visible
                );
                if width == 240 {
                    heights.push(cx.debug_bounds("row-herdr-gpui").unwrap().size.height);
                }
            }
            for (selector, target) in [
                ("row-herdr-gpui", Target::Workspace(0)),
                ("row-Settings window", Target::Workspace(1)),
                ("row-preview-agent-0", Target::Agent(0)),
            ] {
                let bounds = cx.debug_bounds(selector).unwrap();
                cx.simulate_click(bounds.center(), Default::default());
                view.read_with(cx, |view, _| assert_eq!(view.preview.selected, target));
                cx.update(|window, cx| super::super::layout_tests::full_draw(window, cx).clear(cx));
            }
            let fold = cx.debug_bounds("collapse-0").unwrap();
            cx.simulate_click(fold.center(), Default::default());
            view.read_with(cx, |view, _| {
                assert!(view.preview.folded);
                assert_eq!(view.preview.selected, Target::Agent(0));
            });
            cx.update(|window, cx| super::super::layout_tests::full_draw(window, cx).clear(cx));
            assert!(cx.debug_bounds("row-Settings window").is_none());
            view.update(cx, |view, cx| {
                view.preview.toggle_fold();
                view.theme = Theme::builtin("Nord").unwrap();
                view.font.size = 18.;
                cx.notify();
            });
            cx.update(|window, cx| super::super::layout_tests::full_draw(window, cx).clear(cx));
            assert!(
                cx.debug_bounds("row-herdr-gpui").unwrap().size.height > *heights.last().unwrap()
            );
        }
        assert!(heights[1] < heights[0]);
        assert!(heights[2] > heights[0]);
        assert!(heights[8] < heights[0]);
    }
}
