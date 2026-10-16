//! Shared native picker overlay chrome.
use super::*;
impl SnapshotView {
    /// Herdr menu chrome supplies occlusion, themed borders and shadow; like the
    /// TUI palette this floats above the unchanged workspace near its top sixth.
    pub(in crate::tmux_snapshot) fn picker_popover(
        &self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        self.picker.as_ref().filter(|p| {
            matches!(
                p.mode,
                Mode::Commands
                    | Mode::Navigation
                    | Mode::Attention
                    | Mode::Reference
                    | Mode::Help
                    | Mode::WhatsNew
                    | Mode::Font
                    | Mode::Theme
            )
        })?;
        let theme = self.theme();
        let viewport = window.viewport_size();
        let pane_scope = self.picker.as_ref().is_some_and(|p| p.pane_scope.is_some());
        // Pane rows are single-line. Budget heading/search/padding separately,
        // then cap the list so filtering removes empty space without growing past the viewport.
        let content_height = self
            .picker
            .as_ref()
            .filter(|_| pane_scope)
            .map_or(400., |p| {
                let line = crate::config::Config::default().ui.line_height();
                let feedback = if p.error.is_some() { line + 8. } else { 0. };
                (112. + feedback + p.rows.len() as f32 * (line + 8.)).min(240.)
            });
        Some(
            div()
                .id("commands-overlay")
                .debug_selector(|| "commands-overlay".into())
                .absolute()
                .inset_0()
                .size_full()
                .flex()
                .justify_center()
                .pt((viewport.height / 6.).min(px(80.)))
                .occlude()
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(|view, _, window, cx| {
                        view.close_picker(window, cx);
                        cx.stop_propagation();
                    }),
                )
                .on_mouse_down(MouseButton::Right, |_, _, cx| cx.stop_propagation())
                .on_scroll_wheel(|_, _, cx| cx.stop_propagation())
                .child(
                    div()
                        .id("commands-popover")
                        .debug_selector(|| "commands-popover".into())
                        .w((viewport.width - px(24.))
                            .max(px(0.))
                            .min(px(if pane_scope { 360. } else { 560. })))
                        .h(
                            (viewport.height - (viewport.height / 6.).min(px(80.)) - px(48.))
                                .max(px(0.))
                                .min(px(content_height)),
                        )
                        .p_3()
                        .overflow_hidden()
                        .rounded(px(crate::config::corners::PANEL))
                        .border_1()
                        .border_color(super::super::controls::separator(&theme))
                        .bg(rgb(theme.surface))
                        .shadow_lg()
                        .occlude()
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .on_mouse_down(MouseButton::Right, |_, _, cx| cx.stop_propagation())
                        .on_click(|_, _, cx| cx.stop_propagation())
                        .child(self.picker_render(cx)),
                )
                .into_any_element(),
        )
    }
    pub(in crate::tmux_snapshot) fn picker_render(&self, cx: &mut Context<Self>) -> AnyElement {
        if self.picker.as_ref().is_some_and(|p| p.agent.is_some()) {
            return self.new_agent_render(cx);
        }
        if self.picker.as_ref().is_some_and(|p| p.closing.is_some()) {
            return self.pane_close_render(cx);
        }
        let Some(picker) = &self.picker else {
            return div().into_any_element();
        };
        let theme = self.theme();
        let mut panel = div()
            .id("tmux-picker")
            .size_full()
            .flex()
            .flex_col()
            .gap_1()
            .when(picker.mode == Mode::Theme, |panel| {
                panel.child(theme_style::heading(self))
            })
            .when(picker.mode == Mode::Font, |panel| {
                panel
                    .child(div().px_2().py_1().child(format!(
                        "Terminal font · {} · size {}",
                        self.terminal_font.config.family, self.terminal_font.config.size
                    )))
                    .child(
                        div().text_color(rgb(theme.muted)).child(
                            self.terminal_font
                                .note
                                .unwrap_or("Automatic installed symbol fallbacks"),
                        ),
                    )
            })
            .when(picker.mode.is_reference(), |panel| {
                panel.child(div().px_2().py_1().child(reference::heading(picker.mode)))
            })
            .when(picker.mode == Mode::Commands, |panel| {
                panel.child(div().px_2().py_1().child(if picker.pane_scope.is_some() {
                    "Pane actions"
                } else {
                    "Commands · F5"
                }))
            })
            .when(
                picker.mode == Mode::Commands
                    && picker.pane_scope.is_none()
                    && self.browser_state.fleet.is_some(),
                |panel| panel.child(div().px_2().py_1().child(self.palette_status())),
            )
            .when(picker.mode == Mode::Navigation, |panel| {
                panel.child(div().px_2().py_1().child("Sessions and panes · F6"))
            })
            .when(picker.mode == Mode::Attention, |panel| {
                panel.child(self.attention_heading())
            })
            .child(picker.search.clone());
        if picker.mode == Mode::Theme
            && let Some(a) = &self.browser_state.appearance
            && let Some(error) = &a.error
        {
            panel = panel.child(div().id("theme-picker-error").child(error.clone()));
        }
        if let Some(error) = picker.error {
            panel = panel.child(div().id("theme-command-error").child(error));
        }
        let mut list = div()
            .id("picker-results")
            .debug_selector(|| "picker-results".into())
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .track_scroll(&picker.scroll);
        for (index, row) in picker.rows.iter().enumerate() {
            let target = row.target.clone();
            let enabled = !picker.mode.is_reference()
                && match &target {
                    Target::Font(choice) => self.terminal_font.can_choose(choice),
                    _ => true,
                }
                && current(&self.browser_state, &target);
            if picker.mode == Mode::Theme {
                list = list.child(theme_style::row(self, index, row, enabled, cx));
                continue;
            }
            list = list.child(
                div()
                    .id(("picker-row", index))
                    .debug_selector(move || format!("picker-row-{index}"))
                    .px_2()
                    .py_1()
                    .rounded(px(crate::config::corners::CONTROL))
                    .when(!picker.mode.is_reference(), |row| row.truncate())
                    .when(picker.mode.is_reference(), |row| {
                        row.w_full().whitespace_normal()
                    })
                    .when(enabled, |row| row.cursor_pointer())
                    .when(!enabled && !picker.mode.is_reference(), |row| {
                        row.text_color(rgb(theme.muted))
                    })
                    .bg(rgb(if index == picker.selected {
                        theme.active
                    } else {
                        theme.surface
                    }))
                    .when(picker.mode == Mode::Font, |row| {
                        row.min_h(px(super::super::controls::CONTROL_HEIGHT))
                            .flex().items_center().gap_2()
                            .child(div().size(px(16.)).flex_shrink_0().when(
                                matches!(&target, Target::Font(super::super::terminal_font::Choice::Family(name)) if *name == self.terminal_font.config.family),
                                |slot| slot.child(svg().path("icons/check.svg").size_full().text_color(rgb(theme.foreground))),
                            ))
                    })
                    .child(div().min_w_0().when(!picker.mode.is_reference(), |label| label.truncate()).child(row.label.clone()))
                    .when(enabled, |row| {
                        row.on_click(cx.listener(move |view, _, window, cx| {
                            view.choose_picker(target.clone(), window, cx)
                        }))
                    }),
            );
        }
        panel = panel.child(list).when(picker.mode == Mode::Theme, |panel| {
            panel.child(
                div()
                    .pt_2()
                    .text_sm()
                    .text_color(rgb(theme.muted))
                    .child("↑ ↓ Browse   ·   Enter Apply   ·   Esc Close"),
            )
        });
        panel.into_any_element()
    }
}
