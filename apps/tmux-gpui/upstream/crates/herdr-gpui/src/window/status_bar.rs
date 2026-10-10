//! The status bar along the window's foot. `[status_bar]` chooses which of
//! its items show and how compactly, so a crowded bar can give room back.

use super::HerdrWindow;
use crate::{APP_VERSION, config::status_bar::Button, state::ConnectionStatus};
use gpui::{prelude::*, *};
use std::time::Duration;

/// The status bar's 24-unit SVG icons pad their artwork, so they are drawn at
/// this size to look as large as the 12px ring of the report-issue button.
const STATUS_GLYPH: f32 = 16.;

impl HerdrWindow {
    pub(super) fn render_status_bar(&self, cx: &mut Context<Self>) -> Stateful<Div> {
        let status = (!matches!(self.live.status, ConnectionStatus::Connected)
            || self.local_error.is_some()
            || self.live.error.is_some())
        .then(|| self.live.status_text(self.local_error.as_deref()));
        let items = self.config.status_bar;
        div()
            .id("connection-status")
            .debug_selector(|| "connection-status".into())
            .flex()
            .flex_none()
            .h(px((self.config.ui.size * 1.5 + 4.).max(22.)))
            .overflow_hidden()
            .items_center()
            .gap(px(6.))
            .px_3()
            .bg(rgb(self.theme.surface))
            .text_color(rgb(self.theme.foreground))
            .children(self.render_usage(cx))
            .when_some(
                self.prefix_armed
                    .then(|| self.keymap().prefix_label())
                    .flatten(),
                |bar, prefix| {
                    bar.child(
                        div()
                            .debug_selector(|| "prefix-armed".into())
                            .flex_none()
                            .px(px(6.))
                            .rounded(px(crate::config::corners::SMALL))
                            .bg(rgb(self.theme.active))
                            .child(prefix),
                    )
                },
            )
            // The mode has no control on screen, so it says how it works.
            .when(self.resize_mode, |bar| {
                bar.child(
                    div()
                        .debug_selector(|| "resize-mode".into())
                        .flex_none()
                        .px(px(6.))
                        .rounded(px(crate::config::corners::SMALL))
                        .bg(rgb(self.theme.active))
                        .child("Resize"),
                )
                .child(
                    div()
                        .flex_none()
                        .text_color(rgb(self.theme.muted))
                        .child("h j k l or arrows resize, Esc ends"),
                )
            })
            .when(!self.live.status.is_connected(), |bar| {
                bar.child(self.connection_dot())
            })
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .when_some(status, |row, status| {
                        row.child(
                            div()
                                .debug_selector(|| "connection-message".into())
                                .child(status),
                        )
                    }),
            )
            .children(self.render_listening_ports(cx))
            .children(self.render_system_load())
            .children(self.caffeine_button(items.keep_awake, cx))
            .when(items.theme.shown(), |bar| {
                bar.child(
                    self.status_button("status-theme", glyph("icons/theme.svg", self.theme.foreground), "Theme", items.theme)
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.open_theme_picker(window, cx);
                        })),
                )
            })
            .when(items.shortcuts.shown(), |bar| {
                bar.child(
                    self.status_button(
                        "status-keybinds",
                        glyph("icons/keyboard.svg", self.theme.foreground),
                        "Shortcuts",
                        items.shortcuts,
                    )
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.open_keybinds(window, cx);
                    })),
                )
            })
            .when(items.report_issue.shown(), |bar| {
                bar.child(
                    self.status_button("report-issue", self.issue_ring(), "Report issue", items.report_issue)
                        .on_click(|_, _, cx| {
                            cx.open_url(&format!(
                                "https://github.com/penso/herdr-gpui/issues/new?template=bug_report.yml&version={}",
                                APP_VERSION.replace('+', "%2B"),
                            ));
                        }),
                )
            })
            .child(
                div()
                    .id("status-version")
                    .debug_selector(|| "status-version".into())
                    .flex_none()
                    .whitespace_nowrap()
                    .cursor_pointer()
                    .hover(|s| s.bg(rgb(self.theme.active)))
                    // A waiting update is the one status here worth
                    // interrupting for, so it takes the accent color
                    // the rest of the chrome reserves for chosen rows.
                    .text_color(rgb(if self.updater.update_available() {
                        self.theme.primary()
                    } else {
                        self.theme.muted
                    }))
                    .child(if self.updater.update_available() {
                        "Update available"
                    } else {
                        APP_VERSION
                    })
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.open_app_update(false, window, cx);
                    })),
            )
    }

    fn connection_dot(&self) -> AnyElement {
        if matches!(self.live.status, ConnectionStatus::StartingDaemon) {
            div()
                .size(px(8.))
                .flex_none()
                .rounded_full()
                .bg(rgb(self.theme.ink(self.theme.palette[3])))
                .with_animation(
                    "daemon-starting-loader",
                    Animation::new(Duration::from_secs(1)).repeat(),
                    |dot, delta| dot.opacity(0.3 + 0.7 * (delta * std::f32::consts::PI).sin()),
                )
                .into_any_element()
        } else {
            div()
                .size(px(6.))
                .flex_none()
                .rounded_full()
                .bg(rgb(self.theme.ink(self.theme.palette[1])))
                .into_any_element()
        }
    }

    /// Hidden by `keep_awake = false` only while off: the cup is the one
    /// way to let the display sleep again.
    fn caffeine_button(&self, shown: bool, cx: &mut Context<Self>) -> Option<Stateful<Div>> {
        let cup = crate::caffeine::cup(cx);
        if !shown && cup == crate::caffeine::Cup::Off {
            return None;
        }
        let awake = cup == crate::caffeine::Cup::On;
        let button = div()
            .id("status-caffeine")
            .debug_selector(|| "status-caffeine".into())
            .flex_none()
            .flex()
            .items_center()
            .px_2()
            .h_full()
            .cursor_pointer()
            .hover(|s| s.bg(rgb(self.theme.active)))
            .child(glyph(
                if awake {
                    "icons/coffee-full.svg"
                } else {
                    "icons/coffee.svg"
                },
                match cup {
                    crate::caffeine::Cup::On => self.theme.primary(),
                    crate::caffeine::Cup::Pending => self.theme.muted,
                    crate::caffeine::Cup::Off => self.theme.foreground,
                },
            ))
            .tooltip(self.hint(if awake {
                "Keeping the display awake"
            } else {
                "Keep the display awake"
            }))
            .on_click(cx.listener(|_, _, _, cx| {
                let view = cx.entity().downgrade();
                crate::caffeine::toggle(cx, move |error, cx| {
                    let flash = super::Flash::warning(error.to_string());
                    let _ = view.update(cx, |this, cx| this.show_flash(flash, cx));
                });
            }));
        Some(button)
    }

    /// The report-issue button's ring, drawn rather than an SVG.
    fn issue_ring(&self) -> AnyElement {
        div()
            .size(px(12.))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .rounded_full()
            .border_1()
            .border_color(rgb(self.theme.foreground))
            .child(
                div()
                    .size(px(3.))
                    .rounded_full()
                    .bg(rgb(self.theme.foreground)),
            )
            .into_any_element()
    }

    /// A button with its name beside the icon, or the icon alone with the
    /// name in a tooltip. Labelled buttons yield their text to a crowded bar.
    fn status_button(
        &self,
        id: &'static str,
        icon: impl IntoElement,
        label: &'static str,
        style: Button,
    ) -> Stateful<Div> {
        let button = div()
            .id(id)
            .debug_selector(move || id.into())
            .flex()
            .items_center()
            .gap(px(5.))
            .px_2()
            .cursor_pointer()
            .hover(|s| s.bg(rgb(self.theme.active)))
            .child(icon);
        match style {
            Button::Label => button
                .flex_shrink_1()
                .min_w(px(33.))
                .child(div().min_w_0().truncate().child(label)),
            Button::Icon | Button::Hidden => button.flex_none().h_full().tooltip(self.hint(label)),
        }
    }

    fn hint(&self, text: &'static str) -> impl Fn(&mut Window, &mut App) -> AnyView + 'static {
        let (foreground, surface) = (self.theme.foreground, self.theme.surface);
        move |_, cx| {
            cx.new(|_| crate::usage::Hint {
                text: text.into(),
                foreground,
                surface,
            })
            .into()
        }
    }
}

fn glyph(path: &'static str, color: u32) -> Svg {
    svg()
        .path(path)
        .size(px(STATUS_GLYPH))
        .flex_none()
        .text_color(rgb(color))
}
