//! The welcome surface (onboarding A1): icon, title, one sentence, the
//! checklist the app fills in, what the user must act on, and the buttons.
use super::*;
use bezel_theme::{TextStyle, Typeset as _};
use bezel_ui::widgets::{ButtonStyle, Buttons as _, Scaffolding as _, Status as _};
use std::sync::Arc;

/// The app icon, drawn from the bundle's 1024 pt source.
fn app_icon() -> Arc<Image> {
    static ICON: std::sync::OnceLock<Arc<Image>> = std::sync::OnceLock::new();
    ICON.get_or_init(|| {
        Arc::new(Image::from_bytes(
            ImageFormat::Png,
            include_bytes!("../../../../../../assets/AppIcon-1024.png").to_vec(),
        ))
    })
    .clone()
}
const COLUMN: f32 = 560.;
/// The lede wraps to two short lines, as in the mockup.
const LEDE_WIDTH: f32 = 440.;

impl SnapshotView {
    pub(in crate::tmux_snapshot) fn welcome_render(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let bezel = self.home_palette();
        let canvas = self.canvas();
        let connected = self.browser_commands.is_some();
        let stage = stage(&self.browser_state, connected);
        let elapsed = self.welcome_elapsed(cx);
        let checklist = lines(stage, elapsed, self.welcome.stopped_after);
        let known = known_sessions(&self.browser_state);
        let (secondary, primary) = buttons(stage, known.first());
        let closing = matches!(stage, Stage::Ready { .. });
        // The keyboard stops: each listed session's Open (stops 3 to 5),
        // then secondary, primary and skip (stops 0 to 2), as on screen.
        let opens: Vec<(usize, Act)> = match stage {
            Stage::Ready { sessions } if sessions > 0 => known
                .iter()
                .take(3)
                .enumerate()
                .map(|(index, session)| (3 + index, Act::Open(session.open.clone())))
                .collect(),
            _ => Vec::new(),
        };
        while self.welcome.focus.len() < 3 + opens.len() {
            self.welcome.focus.push(cx.focus_handle());
        }
        let focus = self.welcome.focus.clone();
        let mut acts: Vec<(usize, Act)> = Vec::new();
        if let Some(b) = secondary.as_ref().filter(|b| b.enabled) {
            acts.push((0, b.act.clone()));
        }
        if primary.enabled {
            acts.push((1, primary.act.clone()));
        }
        acts.push((2, Act::Close));
        let start = acts
            .iter()
            .find(|(i, _)| *i == 1)
            .map_or(acts[0].0, |(i, _)| *i);
        // A session row that is gone (the session ended, or the list was
        // lost) takes its Open button with it. If that button had the
        // keyboard, nothing on screen has it now: hand it to the start stop.
        let stranded = focus
            .iter()
            .enumerate()
            .any(|(stop, handle)| stop >= 3 + opens.len() && handle.is_focused(window));
        if stranded
            || (self.welcome_may_take_focus(window, cx)
                && !focus.iter().any(|f| f.contains_focused(window, cx)))
        {
            focus[start].focus(window, cx);
        }
        let acts: Vec<(usize, Act)> = opens.into_iter().chain(acts).collect();
        // What the user must act on stays in front of the welcome: an act
        // card other than setup's own (which the welcome is), and the
        // pane-limit notice.
        let act_card = super::super::connection::card(&self.browser_state, connected)
            .filter(|_| {
                self.browser_state.act.is_some() || self.browser_state.local_setup.is_none()
            })
            .map(|card| self.act_card(card, cx));
        let notice = self.browser_state.home_notice.as_ref().map(|notice| {
            bezel
                .warning_strip(crate::notifications::safe_text(notice, 480))
                .text_color(bezel.warning_muted)
                .debug_selector(|| "welcome-notice".into())
                .w_full()
        });
        // The primary is filled with the theme's one accent, as Home's New
        // session… is (#746); the secondary is Bezel's ghost.
        let mut accent = bezel.clone();
        let theme = self.theme();
        accent.text = rgb(theme.primary()).into();
        accent.on_solid = rgb(super::super::new_session::on_accent(
            theme.primary(),
            theme.background,
        ))
        .into();
        let control = |index: usize, button: &Button, style: ButtonStyle| {
            let act = button.act.clone();
            let enabled = button.enabled;
            let ring = bezel.ring;
            let selector = format!("welcome-button-{index}");
            let palette = if style == ButtonStyle::Prominent && enabled {
                &accent
            } else {
                &bezel
            };
            palette
                .button(button.label.clone(), style, None)
                .id(("welcome-button", index))
                .debug_selector(move || selector.clone())
                .role(Role::Button)
                .aria_label(button.label.clone())
                .when(!enabled, |b| b.opacity(0.6))
                .track_focus(&focus[index].clone().tab_stop(enabled))
                .border_1()
                .border_color(transparent_black())
                .focus_visible(move |s| s.border_color(ring))
                .when(enabled, |b| {
                    b.cursor_pointer()
                        .on_click(cx.listener(move |view, _, window, cx| {
                            cx.stop_propagation();
                            view.welcome_act(act.clone(), window, cx);
                        }))
                })
        };
        let rows = checklist.iter().enumerate().map(|(index, line)| {
            let label = if line.status.is_empty() {
                line.title.clone()
            } else {
                format!("{}: {}", line.title, line.status)
            };
            div()
                .id(("welcome-line", index))
                .debug_selector(move || format!("welcome-line-{index}"))
                .role(Role::ListItem)
                .aria_label(label)
                .when_some(line.detail.clone(), |row, detail| {
                    row.aria_description(detail)
                })
                .w_full()
                .px(px(16.))
                .py(px(10.))
                .flex()
                .items_center()
                .gap(px(12.))
                .when(index > 0, |row| {
                    row.border_t_1().border_color(bezel.border_faint)
                })
                .child(mark(line.mark, &bezel))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .child(div().text_color(bezel.text).child(line.title.clone()))
                        .children(line.detail.clone().map(|detail| {
                            div()
                                .text_style(TextStyle::Callout)
                                .text_color(bezel.text_muted)
                                .children(super::super::design::ink_probe(move || {
                                    format!("welcome-detail-{index}")
                                }))
                                .child(detail)
                        })),
                )
                .child(
                    div()
                        .flex_none()
                        .text_style(TextStyle::Callout)
                        .text_color(bezel.text_muted)
                        .child(line.status.clone()),
                )
        });
        let sessions = match stage {
            Stage::Ready { sessions } if sessions > 0 => known
                .iter()
                .take(3)
                .enumerate()
                .map(|(index, session)| {
                    let open = session.open.clone();
                    let muted = bezel.text_muted;
                    let open_ring = bezel.ring;
                    div()
                        .id(("welcome-session", index))
                        .debug_selector(move || format!("welcome-session-{index}"))
                        .role(Role::ListItem)
                        .aria_label(session.label.clone())
                        .w_full()
                        .px(px(12.))
                        .py(px(8.))
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .border_t_1()
                        .border_color(bezel.border_faint)
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .child(session.label.clone()),
                        )
                        .children(session.detail.clone().map(|count| {
                            div()
                                .flex_none()
                                .text_style(TextStyle::Callout)
                                .text_color(muted)
                                .child(count)
                        }))
                        .child(
                            bezel
                                .button("Open", ButtonStyle::Ghost, None)
                                .id(("welcome-open", index))
                                .role(Role::Button)
                                .aria_label(format!("Open {}", session.label))
                                .track_focus(&focus[3 + index].clone().tab_stop(true))
                                // The ring's border, without moving the button.
                                .border_1()
                                .m(px(-1.))
                                .border_color(transparent_black())
                                .focus_visible(move |s| s.border_color(open_ring))
                                .cursor_pointer()
                                .on_click(cx.listener(move |view, _, window, cx| {
                                    cx.stop_propagation();
                                    view.welcome_act(Act::Open(open.clone()), window, cx);
                                })),
                        )
                        .into_any_element()
                })
                .collect::<Vec<_>>(),
            _ => Vec::new(),
        };
        let stuck = matches!(stage, Stage::Setup(Phase::Failed | Phase::StoppedWaiting));
        let skip_label = if closing { "Close" } else { "Skip for now" };
        let skip_ring = bezel.ring;
        let skip = div()
            .id("welcome-skip")
            .debug_selector(|| "welcome-skip".into())
            .role(Role::Button)
            .aria_label(skip_label)
            .track_focus(&focus[2].clone().tab_stop(true))
            .px(px(2.))
            .rounded(px(4.))
            .border_1()
            .border_color(transparent_black())
            .focus_visible(move |s| s.border_color(skip_ring))
            .underline()
            .cursor_pointer()
            .child(skip_label)
            .on_click(cx.listener(|view, _, window, cx| {
                cx.stop_propagation();
                view.welcome_act(Act::Close, window, cx);
            }));
        let footer = div()
            .id("welcome-footer")
            .debug_selector(|| "welcome-footer".into())
            .flex()
            .flex_wrap()
            .justify_center()
            .items_center()
            .gap(px(4.))
            .text_style(TextStyle::Callout)
            .text_color(bezel.text_muted)
            .children(super::super::design::ink_probe(|| "welcome-footer".into()))
            .when(stuck, |f| {
                f.aria_label(STUCK)
                    .child("Still stuck? Run")
                    .child(
                        div()
                            .font_family(crate::config::Config::default().terminal.family)
                            .text_color(bezel.text)
                            .child("tmux-ide doctor"),
                    )
                    .child("in Terminal, or")
                    .child(
                        div()
                            .id("welcome-help")
                            .debug_selector(|| "welcome-help".into())
                            .role(Role::Link)
                            .aria_label("Get help")
                            .underline()
                            .cursor_pointer()
                            .child("get help.")
                            .on_click(|_, _, cx| cx.open_url(HELP_URL)),
                    )
            })
            .when(!stuck, |f| {
                f.child(skip)
                    .when(!closing, |f| f.child(format!("· {SKIP_HINT}")))
            });
        let order = acts.clone();
        let column = div()
            .id("welcome")
            .debug_selector(|| "welcome".into())
            .key_context("Welcome")
            .on_key_down(cx.listener(move |view, event: &KeyDownEvent, window, cx| {
                view.welcome_key(event, &order, window, cx)
            }))
            .w(px(COLUMN))
            .max_w_full()
            .mt(px(96.))
            .flex()
            .flex_col()
            .items_center()
            .gap(px(16.))
            .child(
                img(app_icon())
                    .debug_selector(|| "welcome-icon".into())
                    .size(px(72.)),
            )
            .child(
                div()
                    .id("welcome-title")
                    .debug_selector(|| "welcome-title".into())
                    .role(Role::Heading)
                    .text_style(TextStyle::LargeTitle)
                    .font_weight(FontWeight::BOLD)
                    .text_color(bezel.text)
                    .child(if matches!(stage, Stage::Ready { sessions: 0 }) {
                        READY_TITLE
                    } else {
                        TITLE
                    }),
            )
            .child(
                div()
                    .debug_selector(|| "welcome-lede".into())
                    .max_w(px(LEDE_WIDTH))
                    .text_align(TextAlign::Center)
                    .text_color(bezel.text_muted)
                    .children(super::super::design::ink_probe(|| "welcome-lede".into()))
                    .child(LEDE),
            )
            .children(act_card)
            .children(notice)
            .child(
                bezel
                    .group_box()
                    .id("welcome-checklist")
                    .debug_selector(|| "welcome-checklist".into())
                    .role(Role::List)
                    .aria_label("Setup")
                    .w_full()
                    .p_0()
                    .gap_0()
                    .children(rows)
                    .children(sessions),
            )
            .child(
                div()
                    .flex()
                    .justify_center()
                    .gap(px(12.))
                    .children(
                        secondary
                            .as_ref()
                            .map(|b| control(0, b, ButtonStyle::Ghost)),
                    )
                    .child(control(1, &primary, ButtonStyle::Prominent)),
            )
            .child(footer);
        let page = div()
            .id("welcome-page")
            .flex_1()
            .min_h_0()
            .w_full()
            .flex()
            .flex_col()
            .items_center()
            .px(px(24.))
            .child(column);
        div()
            .id("tmux-home")
            .debug_selector(|| "tmux-home".into())
            .track_focus(&self.terminal_focus)
            .flex_1()
            .min_w_0()
            .h_full()
            .flex()
            .flex_col()
            .bg(rgb(canvas))
            .text_style(TextStyle::Body)
            .child(bezel_ui::scroll::Viewport::new("welcome-scroll", page, Axis::Vertical).fill())
            .into_any_element()
    }
    /// The welcome takes the keyboard only when nothing else holds it: no
    /// palette, card or dialog is open over it, and the window has no focus
    /// or only Home's own.
    fn welcome_may_take_focus(&self, window: &Window, cx: &App) -> bool {
        self.picker.is_none()
            && self.about.is_none()
            && self.new_session.is_none()
            && self.pane_close.is_none()
            && self.pane_actions.is_none()
            && self.browser_address.is_none()
            && (window.focused(cx).is_none() || self.terminal_focus.is_focused(window))
    }
    /// Tab and Shift-Tab move between the welcome's buttons; Return and
    /// Space press the focused one.
    fn welcome_key(
        &mut self,
        event: &KeyDownEvent,
        order: &[(usize, Act)],
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let key = &event.keystroke;
        if key.modifiers.platform || key.modifiers.control || key.modifiers.alt || event.is_held {
            return;
        }
        let at = order
            .iter()
            .position(|(i, _)| self.welcome.focus[*i].is_focused(window));
        match key.key.as_str() {
            "tab" => {
                let next = match (at, key.modifiers.shift) {
                    (None, _) => 0,
                    (Some(i), false) => (i + 1) % order.len(),
                    (Some(i), true) => (i + order.len() - 1) % order.len(),
                };
                self.welcome.focus[order[next].0].clone().focus(window, cx);
            }
            "enter" | "space" => {
                let Some(at) = at else {
                    return;
                };
                self.welcome_act(order[at].1.clone(), window, cx);
            }
            _ => return,
        }
        cx.stop_propagation();
        window.prevent_default();
        cx.notify();
    }
}

/// A line's mark: a tick, an open ring, a still "…" while it runs (no
/// spinner, so Reduce Motion needs nothing more), or an alert.
fn mark(mark: Mark, bezel: &bezel_theme::Theme) -> AnyElement {
    let base = div()
        .flex_none()
        .size(px(16.))
        .flex()
        .items_center()
        .justify_center();
    match mark {
        Mark::Done => base
            .child(
                bezel_ui::icons::icon(bezel_ui::icons::Icon::asset("icons/check.svg"))
                    .size(px(14.))
                    .text_color(bezel.success),
            )
            .into_any_element(),
        Mark::Pending => base
            .child(
                div()
                    .size(px(14.))
                    .rounded_full()
                    .border_1()
                    .border_color(bezel.text_muted),
            )
            .into_any_element(),
        Mark::Running => base
            .text_color(bezel.text_muted)
            .child("…")
            .into_any_element(),
        Mark::Problem => base
            .child(
                div()
                    .size(px(16.))
                    .rounded_full()
                    .bg(bezel.danger)
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_style(TextStyle::Caption)
                    .font_weight(FontWeight::BOLD)
                    .text_color(white())
                    .child("!"),
            )
            .into_any_element(),
    }
}
