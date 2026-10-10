//! The usage panel a status bar segment opens: one tab per signed-in agent on
//! the selected host, its account, every limit with its pace, whatever else
//! its service reports, and links to the service's own pages.

use super::{
    Access, KeychainGrants, Reading, model::Provider, render::ago, service::Service, ui::Ui,
};
use crate::{menu::Page, window::HerdrWindow};
use gpui::{prelude::*, *};
use std::time::{Instant, SystemTime};

pub(crate) const PANEL_WIDTH: f32 = 340.;
/// The gap between the status bar and the panel it opened.
pub(crate) const PANEL_GAP: f32 = 6.;

impl HerdrWindow {
    pub(crate) fn open_usage(
        &mut self,
        provider: Provider,
        anchor: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.open_menu(window, cx) {
            self.menu.anchor = anchor;
            self.menu.page = Some(Page::Usage(provider));
        }
    }

    /// Shows `provider` in the panel and leads the status bar with it.
    fn choose_usage(&mut self, provider: Provider) {
        self.menu.page = Some(Page::Usage(provider));
        self.usage.choose(provider);
    }

    /// Left and right step through the tabs, as the pointer does, so the
    /// status bar follows the keyboard too.
    pub(crate) fn usage_key(
        &mut self,
        provider: Provider,
        event: &KeyDownEvent,
        cx: &mut Context<Self>,
    ) -> bool {
        let providers: Vec<_> = self
            .usage
            .current()
            .map(|entry| {
                entry
                    .tabs(&self.config.usage)
                    .iter()
                    .map(|r| r.provider)
                    .collect()
            })
            .unwrap_or_default();
        let Some(index) = providers.iter().position(|p| *p == provider) else {
            return false;
        };
        let count = providers.len();
        let next = match event.keystroke.key.as_str() {
            "left" => (index + count - 1) % count,
            "right" => (index + 1) % count,
            _ => return false,
        };
        self.choose_usage(providers[next]);
        cx.notify();
        true
    }

    pub(crate) fn render_usage_panel(
        &self,
        provider: Provider,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = &self.theme;
        let font = &self.config.ui;
        let small = px(font.size * 0.9);
        let now = SystemTime::now();
        let entry = self.usage.current();
        let readings = entry
            .map(|entry| entry.tabs(&self.config.usage))
            .unwrap_or_default();
        let reading = readings.iter().copied().find(|r| r.provider == provider);
        let rule = || div().h(px(1.)).my(px(6.)).bg(rgb(theme.active));
        let mut view = div()
            .id("usage-panel")
            .debug_selector(|| "usage-panel".into())
            .flex()
            .flex_col()
            .min_h_0()
            .overflow_y_scroll()
            .track_scroll(&self.menu.usage_scroll)
            .px(px(6.))
            .py(px(4.));
        let service = provider.service();
        let account = reading
            .and_then(|r| r.report.as_ref())
            .map(|report| report.account.clone())
            .unwrap_or_default();
        let updated = entry
            .and_then(|entry| entry.updated)
            .map(|at| {
                format!(
                    "Updated {} ago",
                    ago(now.duration_since(at).unwrap_or_default())
                )
            })
            .unwrap_or_else(|| {
                if self.usage.busy() {
                    "Updating…".into()
                } else {
                    "Not updated yet".into()
                }
            });
        let host = self
            .endpoints
            .get(self.selected_endpoint)
            .map(|endpoint| endpoint.label.clone())
            .unwrap_or_default();
        view = view.child(
            div()
                .debug_selector(|| "usage-panel-header".into())
                .px(px(8.))
                .py(px(6.))
                .flex()
                .justify_between()
                .gap(px(12.))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .child(
                            div()
                                .text_size(px(font.size * 1.25))
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(service.meta().name),
                        )
                        .child(
                            div()
                                .truncate()
                                .text_size(small)
                                .text_color(rgb(theme.muted))
                                .child(format!("{updated} · {host}")),
                        ),
                )
                .child(
                    div()
                        .flex_none()
                        .max_w(px(PANEL_WIDTH * 0.6))
                        .flex()
                        .flex_col()
                        .items_end()
                        .text_color(rgb(theme.muted))
                        .children(
                            account
                                .email
                                .map(|email| div().max_w_full().truncate().child(email)),
                        )
                        .children(account.plan.map(|plan| div().text_size(small).child(plan))),
                ),
        );
        // A sign-in waiting on Keychain access is explained below instead.
        let errors = reading
            .filter(|r| r.access.is_none())
            .and_then(|r| r.error.clone())
            .into_iter()
            .chain(entry.and_then(|entry| entry.error.clone()));
        for error in errors {
            view = view.child(
                div()
                    .px(px(8.))
                    .pb(px(4.))
                    .text_size(small)
                    .text_color(rgb(theme.ink(theme.palette[3])))
                    .child(error),
            );
        }
        let ui = Ui {
            theme: self.theme.clone(),
            font_size: font.size,
            now,
        };
        let access = reading.and_then(|r| r.access);
        if let Some(access) = access {
            view = view
                .child(rule())
                .child(self.usage_access(provider, access, cx));
        }
        if let Some(report) = reading.and_then(|r| r.report.as_ref()) {
            view = view.child(rule()).child(service.render(report, &ui, cx));
        } else if access.is_none() && !service.meta().settings.is_empty() {
            // Nothing to show yet: say what would sign it in.
            view = view.child(rule()).child(setup(service, &ui));
        }
        let body = view
            .child(rule())
            .child(self.usage_action(
                "usage-refresh-row",
                "icons/refresh.svg",
                "Refresh",
                cx.listener(|this, _, _, cx| {
                    this.usage.refresh(Instant::now());
                    cx.notify();
                }),
            ))
            .children(service.meta().dashboard.map(|url| {
                self.usage_action(
                    "usage-dashboard",
                    "icons/chart.svg",
                    "Usage Dashboard",
                    move |_, _, cx| cx.open_url(url),
                )
            }))
            .children(service.meta().status_page.map(|url| {
                self.usage_action(
                    "usage-status",
                    "icons/pulse.svg",
                    "Status Page",
                    move |_, _, cx| cx.open_url(url),
                )
            }));
        // The tabs sit on the panel's bottom edge, beside the status bar it
        // rises from: switching agents changes the panel's height above them,
        // so they never move under the pointer.
        div()
            .flex()
            .flex_col()
            .min_h_0()
            .child(body.flex_shrink_1())
            .when(readings.len() > 1, |panel| {
                panel.child(
                    div()
                        .flex_none()
                        .px(px(6.))
                        .pb(px(6.))
                        .child(div().h(px(1.)).mb(px(6.)).bg(rgb(theme.active)))
                        .child(self.usage_tabs(&readings, provider, cx)),
                )
            })
    }

    fn usage_tabs(
        &self,
        readings: &[&Reading],
        selected: Provider,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = &self.theme;
        div()
            .flex()
            .flex_wrap()
            .children(readings.iter().map(|reading| {
                let provider = reading.provider;
                let chosen = provider == selected;
                let (background, text) = if chosen {
                    let wash = theme.primary_wash();
                    (Some(wash), theme.text_on(wash))
                } else {
                    (None, theme.muted)
                };
                let key = provider.id();
                // Two tabs share the row; more wrap four to a row, as CodexBar's do.
                let width = if readings.len() <= 2 { 0.5 } else { 0.25 };
                div()
                    .id(SharedString::from(format!("usage-tab-{key}")))
                    .debug_selector(move || format!("usage-tab-{key}"))
                    .w(relative(width))
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(2.))
                    .py(px(6.))
                    .rounded(px(crate::config::corners::CONTROL))
                    .cursor_pointer()
                    .text_color(rgb(text))
                    .when_some(background, |tab, background| tab.bg(rgb(background)))
                    .when(!chosen, |tab| tab.hover(|s| s.bg(rgb(theme.active))))
                    .child(
                        svg()
                            .path(provider.icon())
                            .size(px(16.))
                            .text_color(rgb(text)),
                    )
                    .child(div().max_w_full().truncate().child(provider.name()))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        cx.stop_propagation();
                        this.choose_usage(provider);
                        cx.notify();
                    }))
            }))
    }

    /// Why the sign-in is not read yet, and the one control that makes macOS
    /// ask, so the prompt only ever follows the user's own click.
    fn usage_access(
        &self,
        provider: Provider,
        access: Access,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = &self.theme;
        let name = provider.name();
        let (text, label) = match access {
            Access::Needed => (
                format!(
                    "{name}'s sign-in is kept in the macOS Keychain, so reading it makes macOS ask \
                     for permission. Choose Always Allow to see these numbers at launch without \
                     being asked again."
                ),
                "Allow Keychain Access",
            ),
            Access::Denied => (
                format!(
                    "macOS was not allowed to share {name}'s sign-in. Try again to have macOS \
                     ask once more."
                ),
                "Try Again",
            ),
        };
        div()
            .flex()
            .flex_col()
            .child(
                div()
                    .px(px(8.))
                    .py(px(4.))
                    .text_size(px(self.config.ui.size * 0.9))
                    .text_color(rgb(theme.muted))
                    .child(text),
            )
            .child(self.usage_action(
                "usage-allow-keychain",
                "icons/lock.svg",
                label,
                cx.listener(move |this, _, _, cx| {
                    KeychainGrants::grant(provider, cx);
                    this.usage.allow(provider, Instant::now());
                    cx.notify();
                }),
            ))
    }

    fn usage_action(
        &self,
        id: &'static str,
        icon: &'static str,
        label: &'static str,
        action: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> impl IntoElement {
        let theme = &self.theme;
        div()
            .id(id)
            .debug_selector(move || id.into())
            .px(px(8.))
            .py(px(6.))
            .flex()
            .items_center()
            .gap(px(8.))
            .rounded(px(crate::config::corners::CONTROL))
            .cursor_pointer()
            .hover(|s| s.bg(rgb(theme.active)))
            .child(
                svg()
                    .path(icon)
                    .size(px(14.))
                    .flex_none()
                    .text_color(rgb(theme.foreground)),
            )
            .child(label)
            .on_click(move |event, window, cx| {
                cx.stop_propagation();
                action(event, window, cx);
            })
    }
}

/// Where each of the provider's settings goes and how to find its value.
fn setup(service: &dyn Service, ui: &Ui) -> AnyElement {
    ui.block()
        .child(ui.heading("Set up"))
        .children(service.meta().settings.iter().map(|setting| {
            let variables = if setting.env.is_empty() {
                String::new()
            } else {
                format!(" or {}", setting.env.join(", "))
            };
            div()
                .flex()
                .flex_col()
                .gap(px(2.))
                .text_size(ui.small())
                .child(format!(
                    "[usage.providers.{}] {}{variables}",
                    service.meta().id,
                    setting.name
                ))
                .child(div().text_color(ui.muted()).child(setting.help))
        }))
        .into_any_element()
}
