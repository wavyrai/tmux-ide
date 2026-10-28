//! Forwarding a saved device's ports from its menu: the dialog that names a
//! port, and the host menu's list of forwards with their actions. The forwards
//! themselves live in [`crate::port_forward`].
use super::HostMenu;
use crate::{HerdrWindow, menu::Page};
use gpui::{prelude::*, *};
use std::num::NonZeroU16;

impl HerdrWindow {
    /// Starts the forward and returns to the host's menu, which shows it
    /// connecting; a refused port keeps the dialog open and says why.
    pub(super) fn submit_forward_port(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(host) = &mut self.menu.host else {
            return;
        };
        let Some(input) = &host.input else {
            return;
        };
        if input.read(cx).is_composing() {
            return;
        }
        let started = crate::port_forward::parse_port(input.read(cx).text())
            .and_then(|port| self.port_forwards.start(&host.target, port));
        match started {
            Ok(()) => {
                host.input = None;
                host.error = None;
                host.selected = None;
                self.menu.page = Some(Page::Host);
                window.focus(&self.menu.focus, cx);
            }
            Err(error) => host.error = Some(error.to_string()),
        }
        cx.notify();
    }

    /// Whether the open host menu has forwarded ports to list.
    pub(in crate::menu) fn host_menu_lists_forwards(&self) -> bool {
        self.menu
            .host
            .as_ref()
            .is_some_and(|host| self.port_forwards.for_host(&host.target).next().is_some())
    }

    /// Opens a listening forward's page in a browser tab.
    fn open_forward(
        &mut self,
        remote_port: NonZeroU16,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(host) = &self.menu.host else {
            return;
        };
        let url = self
            .port_forwards
            .for_host(&host.target)
            .find(|forward| forward.remote_port() == remote_port)
            .and_then(crate::port_forward::Forward::url);
        if let Some(url) = url {
            self.dismiss_menu(window, cx);
            self.open_browser_tab(Some(url), window, cx);
        }
    }

    /// Stops a forward, or dismisses one that ended.
    fn stop_forward(&mut self, remote_port: NonZeroU16, cx: &mut Context<Self>) {
        if let Some(host) = &self.menu.host
            && self.port_forwards.stop(&host.target, remote_port)
        {
            cx.notify();
        }
    }

    /// The host's forwarded ports, each with its state and the actions it
    /// allows. Nothing at all when there are none.
    pub(super) fn render_forwards(&self, host: &HostMenu, cx: &mut Context<Self>) -> Div {
        use crate::port_forward::State;
        let theme = &self.theme;
        let small = px(self.config.ui.size * 0.85);
        let mut section = div().debug_selector(|| "host-forwards".into());
        let mut any = false;
        for forward in self.port_forwards.for_host(&host.target) {
            if !any {
                section = section
                    .mt(px(4.))
                    .pt(px(4.))
                    .border_t_1()
                    .border_color(rgb(theme.active))
                    .child(
                        div()
                            .px(px(8.))
                            .py(px(4.))
                            .text_size(small)
                            .text_color(rgb(theme.muted))
                            .child("Forwarded ports"),
                    );
                any = true;
            }
            let remote_port = forward.remote_port();
            let port = remote_port.get();
            let (status, ended) = match forward.state() {
                State::Starting => ("connecting…".to_owned(), None),
                State::Listening { local_port } => (format!("→ 127.0.0.1:{local_port}"), None),
                State::Ended(reason) => ("ended".to_owned(), Some(reason.clone())),
            };
            let button = |id: &'static str, label: &'static str| {
                div()
                    .id((id, usize::from(port)))
                    .debug_selector(move || format!("{id}-{port}"))
                    .flex_none()
                    .px(px(6.))
                    .py(px(2.))
                    .rounded(px(crate::config::corners::CONTROL))
                    .cursor_pointer()
                    .hover(|button| button.bg(rgb(theme.active)))
                    .child(label)
            };
            let row = div()
                .debug_selector(move || format!("host-forward-{port}"))
                .min_h(px(self.config.ui.line_height() + 8.))
                .px(px(8.))
                .flex()
                .items_center()
                .gap(px(4.))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .child(port.to_string())
                        .child(
                            div()
                                .text_size(small)
                                .text_color(if ended.is_some() {
                                    crate::menu::danger(theme)
                                } else {
                                    rgb(theme.muted)
                                })
                                .child(status),
                        ),
                )
                .when(forward.url().is_some(), |row| {
                    row.child(button("host-forward-open", "Open").on_click(cx.listener(
                        move |this, _, window, cx| this.open_forward(remote_port, window, cx),
                    )))
                })
                .child(
                    button(
                        "host-forward-stop",
                        if ended.is_some() { "Dismiss" } else { "Stop" },
                    )
                    .on_click(
                        cx.listener(move |this, _, _, cx| this.stop_forward(remote_port, cx)),
                    ),
                );
            section = section.child(row).when_some(ended, |section, reason| {
                section.child(
                    div()
                        .px(px(8.))
                        .pb(px(4.))
                        .text_size(small)
                        .text_color(rgb(theme.muted))
                        .child(reason),
                )
            });
        }
        section
    }

    /// A centered modal like Rename: the remote port in the body, Forward in
    /// the footer.
    pub(super) fn render_forward_port(&self, host: &HostMenu, cx: &mut Context<Self>) -> Div {
        let theme = &self.theme;
        let header = div()
            .debug_selector(|| "forward-port-header".into())
            .flex_none()
            .p(px(16.))
            .border_b_1()
            .border_color(rgb(theme.active))
            .flex()
            .items_center()
            .gap(px(12.))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .text_size(px(self.config.ui.size * 1.35))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child("Forward port"),
            )
            .child(
                div()
                    .id("forward-port-close")
                    .px_2()
                    .py_1()
                    .cursor_pointer()
                    .rounded(px(crate::config::corners::CONTROL))
                    .hover(|s| s.bg(rgb(theme.active)))
                    .child("Close")
                    .on_click(cx.listener(|this, _, window, cx| this.dismiss_menu(window, cx))),
            );
        let body = div()
            .debug_selector(|| "forward-port".into())
            .min_h_0()
            .p(px(16.))
            .flex()
            .flex_col()
            .gap(px(12.))
            .child(div().text_color(rgb(theme.muted)).child(format!(
                "Reach a port that a program on {} listens on from this computer, \
                 over SSH. It stays forwarded until you stop it.",
                host.label
            )))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child("Remote port")
                    .when_some(host.input.clone(), |field, input| field.child(input)),
            )
            .when_some(host.error.clone(), |body, error| {
                body.child(
                    div()
                        .debug_selector(|| "forward-port-error".into())
                        .text_color(crate::menu::danger(theme))
                        .child(error),
                )
            });
        let footer = div()
            .flex_none()
            .p(px(16.))
            .border_t_1()
            .border_color(rgb(theme.active))
            .flex()
            .justify_end()
            .child(
                div()
                    .id("forward-port-submit")
                    .debug_selector(|| "forward-port-submit".into())
                    .p(px(8.))
                    .rounded(px(crate::config::corners::CONTROL))
                    .bg(rgb(theme.active))
                    .cursor_pointer()
                    .hover(|s| s.bg(rgb(theme.active).blend(rgba((theme.foreground << 8) | 0x20))))
                    .child("Forward")
                    .on_click(
                        cx.listener(|this, _, window, cx| this.submit_forward_port(window, cx)),
                    ),
            );
        div()
            .flex()
            .flex_col()
            .min_h_0()
            .child(header)
            .child(body)
            .child(footer)
    }
}
