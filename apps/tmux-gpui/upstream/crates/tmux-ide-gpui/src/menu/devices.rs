//! The sidebar's device footer and the device picker that scopes the sidebar
//! to one device or opens the Add Device dialog. Device scope is presentation
//! state; connection ownership stays in `endpoint`.
mod add_device;
#[cfg(feature = "coder")]
pub(super) mod coder;
pub(crate) use add_device::enter;
mod discover;
mod host_menu;
mod setup;
mod wsl;

pub(super) use add_device::Setup;
pub(crate) use host_menu::HostMenu;
pub(super) use wsl::WslSetup;

use super::{Page, colors};
use crate::{Command, HerdrWindow};
use gpui::{prelude::*, *};
use herdr_client::ConnectTarget;

pub(super) const MENU_GAP: f32 = 12.;
pub(super) const MENU_WIDTH: f32 = 280.;

/// How tall an anchored list above the sidebar footer may be, measured from the
/// origin of the button that opened it. The device picker and the session list
/// clamp at the same place, so neither grows over the terminal.
pub(super) fn list_height(anchor_y: Pixels) -> Pixels {
    let chrome = crate::titlebar::HEIGHT
        + crate::worktree_banner::reserved(env!("HERDR_BUILD_WORKTREE") == "1");
    (anchor_y - px(chrome + MENU_GAP + super::MENU_MARGIN + 12.))
        .max(px(48.))
        .min(px(420.))
}

struct SettingsHint {
    text: SharedString,
    foreground: u32,
    surface: u32,
}

impl Render for SettingsHint {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .px(px(8.))
            .py(px(4.))
            .rounded(px(crate::config::corners::CONTROL))
            .shadow_md()
            .text_size(px(12.))
            .text_color(rgb(self.foreground))
            .bg(rgb(self.surface))
            .child(self.text.clone())
    }
}

#[cfg(feature = "cloud")]
fn capitalized(word: &str) -> String {
    let mut chars = word.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}

impl HerdrWindow {
    /// The cloud providers set up in the config, in picker order.
    #[cfg(feature = "cloud")]
    fn cloud_providers(&self) -> Vec<crate::cloud::CloudProvider> {
        if crate::cloud::unavailable().is_some() {
            return Vec::new();
        }
        crate::cloud::CloudProvider::ALL
            .iter()
            .copied()
            .filter(|provider| match provider {
                #[cfg(feature = "coder")]
                crate::cloud::CloudProvider::Coder => self.coder_configured(),
                // The row opens Daytona's Settings tab, which sets it up.
                #[cfg(feature = "daytona")]
                crate::cloud::CloudProvider::Daytona => true,
            })
            .collect()
    }

    /// How many rows the picker offers to add a cloud provider's machine.
    fn cloud_provider_rows(&self) -> usize {
        #[cfg(feature = "cloud")]
        return self.cloud_providers().len();
        #[cfg(not(feature = "cloud"))]
        0
    }

    /// Whether the open page is a cloud provider's add dialog.
    pub(in crate::menu) fn cloud_dialog_open(&self) -> bool {
        #[cfg(feature = "coder")]
        if self.menu.page == Some(Page::AddCoder) {
            return true;
        }
        false
    }

    /// The open cloud provider's add dialog, if one is open.
    pub(in crate::menu) fn render_cloud_dialog(
        &self,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        #[cfg(feature = "coder")]
        if self.menu.page == Some(Page::AddCoder) {
            return Some(self.render_add_coder(cx).into_any_element());
        }
        #[cfg(not(feature = "coder"))]
        let _ = cx;
        None
    }

    /// How many cloud machines are still being added.
    fn cloud_jobs_pending(&self) -> usize {
        #[cfg(feature = "cloud")]
        return self.cloud_jobs.len();
        #[cfg(not(feature = "cloud"))]
        0
    }

    pub(crate) fn device_visible(&self, id: &str) -> bool {
        self.device_filter
            .as_deref()
            .is_none_or(|filter| filter == id)
    }

    pub(super) fn device_setup_unavailable(&self) -> Option<&'static str> {
        match &self.endpoints[0].connection.target {
            ConnectTarget::Socket(_) => {
                Some("Device setup is unavailable with an explicit socket.")
            }
            ConnectTarget::Session {
                development: true, ..
            } => Some("Device setup is unavailable with a development catalog."),
            _ => None,
        }
    }

    /// Why saved SSH devices cannot be added or edited here. Windows saves WSL
    /// distributions instead; its client has no SSH bridge.
    pub(super) fn ssh_setup_unavailable(&self) -> Option<&'static str> {
        self.device_setup_unavailable()
            .or_else(|| cfg!(windows).then_some("Saved SSH devices are unavailable on Windows."))
    }

    pub(crate) fn render_device_footer(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let button_bounds = std::rc::Rc::new(std::cell::Cell::new(Bounds::<Pixels>::default()));
        let painted_bounds = button_bounds.clone();
        // The window owns this cell, so the shortcut and the click anchor the
        // list in the same place and it outlives this frame's rebuild.
        let painted_sessions = self.sessions_anchor.clone();
        let hint: SharedString = self
            .config
            .keybindings
            .shortcuts(Command::Settings)
            .next()
            .map_or_else(
                || "Settings".to_owned(),
                |shortcut| format!("Settings ({shortcut})"),
            )
            .into();
        let foreground = self.theme.foreground;
        let surface = self.theme.surface;
        let label = self
            .device_filter
            .as_ref()
            .and_then(|id| self.endpoints.iter().find(|endpoint| &endpoint.id == id))
            .map_or("All Devices", |endpoint| endpoint.label.as_str());
        let connected = self.endpoints.iter().any(|endpoint| {
            self.device_visible(&endpoint.id) && endpoint.live.status.is_connected()
        });
        div()
            .id("device-footer")
            .debug_selector(|| "device-footer".into())
            .h(px(crate::sidebar::DEVICE_FOOTER_HEIGHT))
            .flex_none()
            .flex()
            .items_center()
            .gap(px(6.))
            .px(px(8.))
            .border_t_1()
            .border_color(rgb(self.theme.active))
            .child(
                div()
                    .id("device-picker")
                    .relative()
                    .debug_selector(|| "device-picker".into())
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .p(px(6.))
                    .rounded(px(crate::config::corners::CONTROL))
                    .cursor_pointer()
                    .hover(|s| s.bg(rgb(self.theme.active)))
                    .child(
                        div()
                            .relative()
                            .flex_none()
                            .child(
                                svg()
                                    .path("icons/devices.svg")
                                    .size(px(16.))
                                    .text_color(rgb(self.theme.foreground)),
                            )
                            // How many Coder workspaces are still being added,
                            // on the icon's corner so the label keeps its room.
                            .when(self.cloud_jobs_pending() > 0, |icon| {
                                icon.child(
                                    div()
                                        .debug_selector(|| "device-footer-adding".into())
                                        .absolute()
                                        .top(px(-6.))
                                        .right(px(-8.))
                                        .min_w(px(13.))
                                        .h(px(13.))
                                        .px(px(3.))
                                        .rounded_full()
                                        .flex()
                                        .items_center()
                                        .justify_center()
                                        .text_size(px(9.))
                                        .bg(colors::accent(&self.theme))
                                        .text_color(rgb(self.theme.background))
                                        .child(self.cloud_jobs_pending().to_string()),
                                )
                            }),
                    )
                    .child(div().flex_1().min_w_0().truncate().child(label.to_owned()))
                    .child(
                        div()
                            .size(px(6.))
                            .flex_none()
                            .rounded_full()
                            .bg(rgb(if connected {
                                colors::online(&self.theme)
                            } else {
                                self.theme.muted
                            })),
                    )
                    .child(
                        svg()
                            .path("icons/chevron-up.svg")
                            .size(px(12.))
                            .flex_none()
                            .text_color(rgb(self.theme.muted)),
                    )
                    .child(
                        canvas(
                            |_, _, _| (),
                            move |bounds, _, _, _| {
                                painted_bounds.set(bounds);
                            },
                        )
                        .absolute()
                        .inset_0()
                        .size_full(),
                    )
                    .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                        if this.open_menu(window, cx) {
                            // Anchor to the control, not the pointer: every click
                            // position leaves the same clear gap above the button.
                            this.menu.anchor = button_bounds.get().origin;
                            this.menu.page = Some(Page::Devices);
                            this.menu.selected = Some(0);
                        }
                    })),
            )
            .child(
                div()
                    .id("device-sessions")
                    .relative()
                    .debug_selector(|| "device-sessions".into())
                    .size(px(28.))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(crate::config::corners::CONTROL))
                    .cursor_pointer()
                    .tooltip(move |_, cx| {
                        cx.new(|_| SettingsHint {
                            text: "Sessions".into(),
                            foreground,
                            surface,
                        })
                        .into()
                    })
                    .hover(|s| s.bg(rgb(self.theme.active)))
                    .child(
                        svg()
                            .path("icons/sessions.svg")
                            .size(px(18.))
                            .text_color(rgb(self.theme.foreground)),
                    )
                    .child(
                        canvas(
                            |_, _, _| (),
                            move |bounds, _, _, _| {
                                painted_sessions.set(bounds.origin);
                            },
                        )
                        .absolute()
                        .inset_0()
                        .size_full(),
                    )
                    .on_click(cx.listener(|this, _: &ClickEvent, window, cx| {
                        this.open_sessions(this.sessions_anchor.get(), window, cx);
                    })),
            )
            .child(
                div()
                    .id("device-settings")
                    .debug_selector(|| "device-settings".into())
                    .size(px(28.))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(crate::config::corners::CONTROL))
                    .cursor_pointer()
                    .tooltip(move |_, cx| {
                        cx.new(|_| SettingsHint {
                            text: hint.clone(),
                            foreground,
                            surface,
                        })
                        .into()
                    })
                    .hover(|s| s.bg(rgb(self.theme.active)))
                    .child(
                        svg()
                            .path("icons/settings.svg")
                            .size(px(18.))
                            .text_color(rgb(self.theme.foreground)),
                    )
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.command(Command::Settings, window, cx);
                    })),
            )
    }

    pub(super) fn render_devices(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let connected = self
            .endpoints
            .iter()
            .filter(|e| e.live.status.is_connected())
            .count();
        let count = self.endpoints.len();
        let mut rows = vec![(
            "All Devices".to_owned(),
            format!(
                "{count} {} · {connected} connected",
                if count == 1 { "device" } else { "devices" }
            ),
            self.device_filter.is_none(),
            true,
        )];
        rows.extend(self.endpoints.iter().map(|endpoint| {
            let detail = match &endpoint.connection.target {
                ConnectTarget::Ssh { target, session } => format!("{target} · {session}"),
                #[cfg(feature = "cloud")]
                ConnectTarget::Cloud {
                    provider,
                    machine,
                    session,
                    ..
                } => format!("{} {machine} · {session}", crate::cloud::name(*provider)),
                ConnectTarget::Wsl { distro, session } => format!("WSL {distro} · {session}"),
                ConnectTarget::Socket(path) => path.display().to_string(),
                ConnectTarget::Session { name, .. } => format!("This device · {name}"),
                ConnectTarget::Local => "This device".into(),
            };
            (
                endpoint.label.clone(),
                format!("{detail} · {}", endpoint.status()),
                self.device_filter.as_ref() == Some(&endpoint.id),
                endpoint.enabled,
            )
        }));
        rows.push((
            "Add Device…".into(),
            self.device_setup_unavailable()
                .unwrap_or(if cfg!(windows) {
                    "Attach to Herdr in a WSL distribution"
                } else {
                    "Set up a remote host over SSH"
                })
                .into(),
            false,
            self.device_setup_unavailable().is_none(),
        ));
        #[cfg(feature = "cloud")]
        for provider in self.cloud_providers() {
            let (name, noun) = (crate::cloud::name(provider), crate::cloud::noun(provider));
            rows.push((
                format!("Add {name} {}…", capitalized(noun)),
                self.device_setup_unavailable()
                    .map(str::to_owned)
                    .unwrap_or_else(|| crate::cloud::offer(provider).to_owned()),
                false,
                self.device_setup_unavailable().is_none(),
            ));
        }
        let mut view = div()
            .id("devices-list")
            .max_h(list_height(self.menu.anchor.y))
            .overflow_y_scroll()
            .track_scroll(&self.menu.devices_scroll)
            .flex()
            .flex_col()
            .gap(px(4.))
            .child(
                div()
                    .p(px(8.))
                    .text_color(rgb(self.theme.muted))
                    .child("DEVICES"),
            );
        for (index, (label, detail, checked, enabled)) in rows.into_iter().enumerate() {
            let endpoint = index.checked_sub(1).and_then(|i| self.endpoints.get(i));
            view = view.child(
                div()
                    .id(("device-row", index))
                    .debug_selector(move || format!("device-row-{index}"))
                    .p(px(8.))
                    .rounded(px(crate::config::corners::CONTROL))
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .when(self.menu.selected == Some(index), |s| {
                        s.bg(rgb(self.theme.active))
                    })
                    // The current scope is highlighted as the session list marks
                    // its current session, rather than with a trailing check.
                    .when(checked, |s| s.bg(rgb(self.theme.primary_wash())))
                    .when(enabled, |s| s.cursor_pointer())
                    .text_color(rgb(if enabled {
                        self.theme.foreground
                    } else {
                        self.theme.muted
                    }))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .justify_between()
                                    .gap(px(8.))
                                    .when(index == 0, |row| {
                                        row.child(
                                            svg()
                                                .path("icons/devices.svg")
                                                .size(px(16.))
                                                .flex_none()
                                                .text_color(rgb(self.theme.foreground)),
                                        )
                                    })
                                    .when(index > self.endpoints.len(), |row| {
                                        row.child(
                                            svg()
                                                .path("icons/plus.svg")
                                                .size(px(16.))
                                                .flex_none()
                                                .text_color(rgb(if enabled {
                                                    self.theme.foreground
                                                } else {
                                                    self.theme.muted
                                                })),
                                        )
                                    })
                                    .child(
                                        div()
                                            .flex_1()
                                            .min_w_0()
                                            .truncate()
                                            .when(checked, |label| {
                                                label
                                                    .debug_selector(move || {
                                                        format!("device-current-{index}")
                                                    })
                                                    .font_weight(FontWeight::SEMIBOLD)
                                            })
                                            .child(label),
                                    ),
                            )
                            .child(
                                div()
                                    .text_size(px(self.config.ui.size * 0.85))
                                    .text_color(rgb(self.theme.muted))
                                    .child(detail),
                            ),
                    )
                    .when_some(endpoint, |row, endpoint| {
                        row.child(
                            div()
                                .debug_selector(move || format!("device-dot-{index}"))
                                .size(px(7.))
                                .flex_none()
                                .rounded_full()
                                .bg(rgb(if endpoint.live.status.is_connected() {
                                    colors::online(&self.theme)
                                } else {
                                    self.theme.muted
                                })),
                        )
                    })
                    .on_hover(cx.listener(move |this, hovered, _, cx| {
                        if *hovered {
                            this.menu.selected = Some(index);
                            cx.notify();
                        }
                    }))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.choose_device(index, window, cx);
                    })),
            );
        }
        // Workspaces still being added: progress only, not selectable rows,
        // so keyboard navigation keeps its indices.
        #[cfg(feature = "cloud")]
        {
            view = self.cloud_job_rows(view);
        }
        view
    }

    /// Machines still being added: progress only, not selectable rows, so
    /// keyboard navigation keeps its indices.
    #[cfg(feature = "cloud")]
    fn cloud_job_rows(&self, mut view: Stateful<Div>) -> Stateful<Div> {
        if !self.cloud_jobs.is_empty() {
            view = view.child(
                div()
                    .p(px(8.))
                    .text_color(rgb(self.theme.muted))
                    .child("ADDING"),
            );
        }
        for (index, provision) in self.cloud_jobs.iter().enumerate() {
            view = view.child(
                div()
                    .debug_selector(move || format!("device-adding-{index}"))
                    .p(px(8.))
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(div().truncate().child(provision.name.clone()))
                            .child(
                                div()
                                    .truncate()
                                    .text_size(px(self.config.ui.size * 0.85))
                                    .text_color(rgb(self.theme.muted))
                                    .child(format!(
                                        "{} · {}",
                                        crate::cloud::name(provision.provider),
                                        provision.status
                                    )),
                            ),
                    )
                    .child(
                        div()
                            .size(px(7.))
                            .flex_none()
                            .rounded_full()
                            .bg(colors::accent(&self.theme)),
                    ),
            );
        }
        view
    }

    fn choose_device(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(offset) = index.checked_sub(self.endpoints.len() + 2) {
            #[cfg(feature = "cloud")]
            if self.device_setup_unavailable().is_none()
                && let Some(provider) = self.cloud_providers().into_iter().nth(offset)
            {
                match provider {
                    #[cfg(feature = "coder")]
                    crate::cloud::CloudProvider::Coder => self.open_coder_setup(window, cx),
                    #[cfg(feature = "daytona")]
                    crate::cloud::CloudProvider::Daytona => {
                        self.dismiss_menu(window, cx);
                        crate::settings_window::open_cloud(cx.weak_entity(), provider, cx);
                    }
                }
            }
            #[cfg(not(feature = "cloud"))]
            let _ = offset;
            return;
        }
        if index == self.endpoints.len() + 1 {
            if self.device_setup_unavailable().is_some() {
                return;
            }
            if cfg!(windows) {
                self.open_add_wsl(window, cx);
            } else {
                self.open_add_device(window, cx);
            }
        } else {
            let filter = if index == 0 {
                None
            } else {
                let Some(endpoint) = self.endpoints.get(index - 1).filter(|e| e.enabled) else {
                    return;
                };
                Some(endpoint.id.clone())
            };
            self.dismiss_menu(window, cx);
            if let Some(id) = &filter
                && !self.select_endpoint(id, cx)
            {
                return;
            }
            self.device_filter = filter;
            for scroll in &self.sidebar_scroll {
                scroll.set_offset(Point::default());
            }
            for revealed in &self.sidebar_revealed {
                revealed.set(None);
            }
            // The row a reveal left for the next frame is in the old list.
            self.sidebar_pin_reveal.set(None);
        }
        cx.notify();
    }

    pub(super) fn devices_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.menu.page == Some(Page::AddDevice) {
            if !self.add_device_key(event, window, cx) {
                return;
            }
        } else {
            let key = event.keystroke.key.as_str();
            let count = self.endpoints.len() + 2 + self.cloud_provider_rows();
            match key {
                "up" | "down" => {
                    let index = self.menu.selected.unwrap_or(0).min(count - 1);
                    self.menu.selected =
                        Some((index + if key == "up" { count - 1 } else { 1 }) % count);
                    if let Some(index) = self.menu.selected {
                        self.menu.devices_scroll.scroll_to_item(index + 1);
                    }
                    cx.notify();
                }
                "enter" => self.choose_device(self.menu.selected.unwrap_or(0), window, cx),
                "escape" => self.dismiss_menu(window, cx),
                _ => {}
            }
        }
        cx.stop_propagation();
        window.prevent_default();
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
