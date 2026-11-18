//! The guide's frame (step rail, hero, title, footer with Skip, Back and
//! Continue) and its Set up step: the welcome (onboarding A1), with the
//! checklist the app fills in and what the user must act on.
use super::guide::{Act as GuideAct, Kind, Step, slot};
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
pub(super) const COLUMN: f32 = 560.;
/// The lede wraps to two short lines, as in the mockup.
const LEDE_WIDTH: f32 = 440.;
/// The app icon's size in the hero slot until illustrations arrive.
const ICON: f32 = 56.;
pub(super) const LOOK_TITLE: &str = "Make it yours";
pub(super) const LOOK_LEDE: &str = "Each choice is saved and applied as you make it.";
pub(super) const KEYS_TITLE: &str = "Keys you'll use";
pub(super) const KEYS_LEDE: &str =
    "Press one to try it here. Every shortcut is listed in Commands: Keyboard shortcuts…";
pub(super) const HINT: &str = "Esc closes · everything is saved as you go";
pub(super) const START_USING: &str = "Start using Tmux IDE";

/// A keyboard stop: its slot in `State.focus`, what it does, and how it
/// answers Return and Space.
pub(super) type Stop = (usize, Act, Kind);

/// The hero slot, one per step (the hero slot contract: 360 × 160 pt,
/// centred). Illustrations are parked, so every step shows the app icon at
/// the welcome's size, and the slot shrinks to it.
fn hero(step: Step) -> AnyElement {
    img(app_icon())
        .debug_selector(move || format!("welcome-hero-{}", step.index()))
        .size(px(ICON))
        .into_any_element()
}

/// The primary palette with the theme's one accent, as Home's New session…
/// is (#746).
pub(super) fn accented(
    bezel: &bezel_theme::Theme,
    theme: &crate::config::Theme,
) -> bezel_theme::Theme {
    let mut accent = bezel.clone();
    accent.text = rgb(theme.primary()).into();
    accent.on_solid = rgb(super::super::new_session::on_accent(
        theme.primary(),
        theme.background,
    ))
    .into();
    accent
}

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
        while self.welcome.focus.len() < slot::COUNT {
            self.welcome.focus.push(cx.focus_handle());
        }
        let step = self.welcome.guide.step;
        let accent = accented(&bezel, &self.theme());
        let (body, body_stops, start) = match step {
            Step::SetUp => self.setup_body(stage, &bezel, &accent, cx),
            Step::Look => self.look_body(&bezel, window, cx),
            Step::Keys => self.keys_body(&bezel, cx),
        };
        let (rail, rail_stops) = self.guide_rail(&bezel, cx);
        let (footer, footer_stops) = self.guide_footer(stage, &bezel, &accent, cx);
        let order: Vec<Stop> = rail_stops
            .into_iter()
            .chain(body_stops)
            .chain(footer_stops)
            .collect();
        let focus = self.welcome.focus.clone();
        // The step's first stop is its primary control; failing that, the
        // first stop there is.
        let start = start
            .filter(|s| order.iter().any(|(slot, _, _)| slot == s))
            .or_else(|| {
                [slot::NEXT, slot::SKIP]
                    .into_iter()
                    .find(|s| order.iter().any(|o| o.0 == *s))
            })
            .unwrap_or(order.first().map_or(slot::SKIP, |o| o.0));
        // A stop that is gone or disabled now (setup started, a session
        // ended) may have had the keyboard: hand it to the start stop.
        let stranded = focus
            .iter()
            .enumerate()
            .any(|(s, handle)| handle.is_focused(window) && !order.iter().any(|o| o.0 == s));
        let take = self.welcome_may_take_focus(window, cx);
        if stranded
            || (take
                && (self.welcome.guide.moved
                    || !focus.iter().any(|f| f.contains_focused(window, cx))))
        {
            focus[start].focus(window, cx);
        }
        self.welcome.guide.moved = false;
        // What the user must act on stays in front of the guide: an act
        // card other than setup's own (which step one is), and the
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
        let (title, lede) = match step {
            Step::SetUp if matches!(stage, Stage::Ready { sessions: 0 }) => (READY_TITLE, LEDE),
            Step::SetUp => (TITLE, LEDE),
            Step::Look => (LOOK_TITLE, LOOK_LEDE),
            Step::Keys => (KEYS_TITLE, KEYS_LEDE),
        };
        let column = div()
            .id("welcome")
            .debug_selector(|| "welcome".into())
            .key_context("Welcome")
            .role(Role::Region)
            .aria_label(title)
            .on_key_down(cx.listener(move |view, event: &KeyDownEvent, window, cx| {
                view.guide_key(event, &order, window, cx)
            }))
            .w(px(COLUMN))
            .max_w_full()
            .mt(px(48.))
            .mb(px(32.))
            .flex()
            .flex_col()
            .items_center()
            .gap(px(16.))
            .child(rail)
            .child(hero(step))
            .child(
                div()
                    .id("welcome-title")
                    .debug_selector(|| "welcome-title".into())
                    .role(Role::Heading)
                    .text_style(TextStyle::LargeTitle)
                    .font_weight(FontWeight::BOLD)
                    .text_color(bezel.text)
                    .child(title),
            )
            .child(
                div()
                    .debug_selector(|| "welcome-lede".into())
                    .max_w(px(LEDE_WIDTH))
                    .text_align(TextAlign::Center)
                    .text_color(bezel.text_muted)
                    .children(super::super::design::ink_probe(|| "welcome-lede".into()))
                    .child(lede),
            )
            .children(act_card)
            .children(notice)
            .child(body)
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

    /// A guide button on `slot`: Bezel's button, a ring when the keyboard
    /// is on it, and nothing to press while disabled.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn guide_button(
        &self,
        slot: usize,
        selector: &'static str,
        label: &str,
        act: Act,
        style: ButtonStyle,
        enabled: bool,
        palette: &bezel_theme::Theme,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let ring = palette.ring;
        let label = label.to_string();
        palette
            .button(label.clone(), style, None)
            .id(selector)
            .debug_selector(move || selector.into())
            .role(Role::Button)
            .aria_label(label)
            .when(!enabled, |b| b.opacity(0.6))
            .track_focus(&self.welcome.focus[slot].clone().tab_stop(enabled))
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
    }

    /// The step rail: each step, numbered, with a tick once visited; a step
    /// not reached yet can't be clicked, so the order teaches but never traps.
    fn guide_rail(
        &self,
        bezel: &bezel_theme::Theme,
        cx: &mut Context<Self>,
    ) -> (AnyElement, Vec<Stop>) {
        let guide = &self.welcome.guide;
        let mut stops = Vec::new();
        let total = Step::ALL.len();
        let theme = self.theme();
        let items = Step::ALL.iter().enumerate().map(|(index, step)| {
            let step = *step;
            let current = step == guide.step;
            let enabled = guide.enabled(step);
            let visited = !current && step.place() <= guide.reached;
            let slot = slot::RAIL + index;
            if enabled {
                stops.push((slot, Act::Guide(GuideAct::Go(step)), Kind::Press));
            }
            let state = if current {
                ", current"
            } else if visited {
                ", visited"
            } else if !enabled {
                ", not reached yet"
            } else {
                ""
            };
            let spoken = format!("Step {} of {total}, {}{state}", index + 1, step.name());
            let ring = bezel.ring;
            let number = div()
                .flex_none()
                .size(px(18.))
                .rounded_full()
                .flex()
                .items_center()
                .justify_center()
                .text_style(TextStyle::Caption)
                .map(|n| {
                    if current {
                        n.bg(rgb(theme.primary()))
                            .text_color(rgb(super::super::new_session::on_accent(
                                theme.primary(),
                                theme.background,
                            )))
                            .child(format!("{}", index + 1))
                    } else if visited {
                        n.child(
                            bezel_ui::icons::icon(bezel_ui::icons::Icon::asset("icons/check.svg"))
                                .size(px(12.))
                                .text_color(bezel.success),
                        )
                    } else {
                        n.border_1()
                            .border_color(bezel.text_muted)
                            .text_color(bezel.text_muted)
                            .child(format!("{}", index + 1))
                    }
                });
            div()
                .id(("welcome-rail", index))
                .debug_selector(move || format!("welcome-rail-{index}"))
                .role(Role::Button)
                .aria_label(spoken)
                .track_focus(&self.welcome.focus[slot].clone().tab_stop(enabled))
                .flex()
                .items_center()
                .gap(px(6.))
                .px(px(6.))
                .py(px(2.))
                .rounded_full()
                .border_1()
                .border_color(transparent_black())
                .focus_visible(move |s| s.border_color(ring))
                .text_style(TextStyle::Callout)
                .text_color(if current {
                    bezel.text
                } else {
                    bezel.text_muted
                })
                .when(current, |d| d.font_weight(FontWeight::SEMIBOLD))
                .when(!enabled, |d| d.opacity(0.6))
                .child(number)
                .child(step.name())
                .when(enabled, |d| {
                    d.cursor_pointer()
                        .on_click(cx.listener(move |view, _, window, cx| {
                            cx.stop_propagation();
                            view.guide_act(GuideAct::Go(step), window, cx);
                        }))
                })
        });
        let rail = div()
            .id("welcome-rail")
            .debug_selector(|| "welcome-rail".into())
            .role(Role::List)
            .aria_label("Setup steps")
            .flex()
            .flex_wrap()
            .justify_center()
            .gap(px(4.))
            .children(items)
            .into_any_element();
        (rail, stops)
    }

    /// Skip setup (or Continue without it, when setup can't finish here),
    /// the hint, Back and Continue.
    fn guide_footer(
        &self,
        stage: Stage,
        bezel: &bezel_theme::Theme,
        accent: &bezel_theme::Theme,
        cx: &mut Context<Self>,
    ) -> (AnyElement, Vec<Stop>) {
        let step = self.welcome.guide.step;
        let mut stops = Vec::new();
        let (skip_label, skip_act) = if step == Step::SetUp && setup_blocked(stage) {
            ("Continue without it", GuideAct::ContinueWithout)
        } else {
            ("Skip setup", GuideAct::Skip)
        };
        stops.push((slot::SKIP, Act::Guide(skip_act.clone()), Kind::Press));
        let skip = self.guide_button(
            slot::SKIP,
            "welcome-skip",
            skip_label,
            Act::Guide(skip_act),
            ButtonStyle::Ghost,
            true,
            bezel,
            cx,
        );
        let back = (step != Step::SetUp).then(|| {
            stops.push((slot::BACK, Act::Guide(GuideAct::Back), Kind::Press));
            self.guide_button(
                slot::BACK,
                "welcome-back",
                "Back",
                Act::Guide(GuideAct::Back),
                ButtonStyle::Ghost,
                true,
                bezel,
                cx,
            )
        });
        let next_enabled = step != Step::SetUp || matches!(stage, Stage::Ready { .. });
        if next_enabled {
            stops.push((slot::NEXT, Act::Guide(GuideAct::Next), Kind::Press));
        }
        let next = self.guide_button(
            slot::NEXT,
            "welcome-next",
            if step == Step::Keys {
                START_USING
            } else {
                "Continue"
            },
            Act::Guide(GuideAct::Next),
            ButtonStyle::Prominent,
            next_enabled,
            if next_enabled { accent } else { bezel },
            cx,
        );
        let footer = div()
            .id("welcome-footer")
            .debug_selector(|| "welcome-footer".into())
            .w_full()
            .pt(px(12.))
            .border_t_1()
            .border_color(bezel.border_faint)
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(8.))
            .child(skip)
            .child(
                div()
                    .debug_selector(|| "welcome-hint".into())
                    .flex_1()
                    .min_w(px(120.))
                    .text_style(TextStyle::Caption)
                    .text_color(bezel.text_muted)
                    .children(super::super::design::ink_probe(|| "welcome-hint".into()))
                    .child(HINT),
            )
            .children(back)
            .child(next)
            .into_any_element();
        (footer, stops)
    }

    /// Step one: the welcome's checklist and the setup's own buttons.
    fn setup_body(
        &self,
        stage: Stage,
        bezel: &bezel_theme::Theme,
        accent: &bezel_theme::Theme,
        cx: &mut Context<Self>,
    ) -> (AnyElement, Vec<Stop>, Option<usize>) {
        let elapsed = self.welcome_elapsed(cx);
        let checklist = lines(stage, elapsed, self.welcome.stopped_after);
        let mut stops = Vec::new();
        let controls = buttons(stage).map(|(secondary, primary)| {
            let secondary = secondary.map(|b| {
                if b.enabled {
                    stops.push((slot::SECONDARY, b.act.clone(), Kind::Press));
                }
                self.guide_button(
                    slot::SECONDARY,
                    "welcome-button-0",
                    &b.label,
                    b.act,
                    ButtonStyle::Ghost,
                    b.enabled,
                    bezel,
                    cx,
                )
            });
            if primary.enabled {
                stops.push((slot::PRIMARY, primary.act.clone(), Kind::Press));
            }
            let primary = self.guide_button(
                slot::PRIMARY,
                "welcome-button-1",
                &primary.label,
                primary.act,
                ButtonStyle::Prominent,
                primary.enabled,
                if primary.enabled { accent } else { bezel },
                cx,
            );
            div()
                .flex()
                .justify_center()
                .gap(px(12.))
                .children(secondary)
                .child(primary)
        });
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
                .child(mark(line.mark, bezel))
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
        let stuck = matches!(stage, Stage::Setup(Phase::Failed | Phase::StoppedWaiting));
        let help = stuck.then(|| {
            div()
                .id("welcome-stuck")
                .debug_selector(|| "welcome-stuck".into())
                .flex()
                .flex_wrap()
                .justify_center()
                .items_center()
                .gap(px(4.))
                .text_style(TextStyle::Callout)
                .text_color(bezel.text_muted)
                .children(super::super::design::ink_probe(|| "welcome-stuck".into()))
                .aria_label(STUCK)
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
        });
        let body = div()
            .w_full()
            .flex()
            .flex_col()
            .items_center()
            .gap(px(16.))
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
                    .children(rows),
            )
            .children(controls)
            .children(help)
            .into_any_element();
        (body, stops, Some(slot::PRIMARY))
    }

    /// The guide takes the keyboard only when nothing else holds it: no
    /// palette, card or dialog is open over it, and the window has no focus
    /// or only Home's own.
    fn welcome_may_take_focus(&self, window: &Window, cx: &App) -> bool {
        self.picker.is_none()
            && self.about.is_none()
            && self.new_session.is_none()
            && self.pane_close.is_none()
            && self.pane_actions.is_none()
            && self.browser_address.is_none()
            && (window.focused(cx).is_none()
                || self.terminal_focus.is_focused(window)
                || self
                    .welcome
                    .focus
                    .iter()
                    .any(|f| f.contains_focused(window, cx)))
    }
}

/// A line's mark: a tick, an open ring, a still "…" while it runs (no
/// spinner, so Reduce Motion needs nothing more), or an alert.
pub(super) fn mark(mark: Mark, bezel: &bezel_theme::Theme) -> AnyElement {
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
