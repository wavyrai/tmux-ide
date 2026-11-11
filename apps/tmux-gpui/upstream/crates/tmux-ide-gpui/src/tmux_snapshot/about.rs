//! About Tmux IDE: a small Bezel dialog card with the app's name, version and
//! channel, the background service it is connected to, three links and Copy
//! diagnostics. A placeholder for the designed About, kept to Bezel parts.
use super::SnapshotView;
use super::controls::{self, ButtonStyle, Icon};
use super::menu_bar::APP_NAME;
use gpui::{prelude::*, *};
use std::sync::{Arc, LazyLock};

const WEBSITE: &str = "https://tmux-ide.com";
const DOCS: &str = "https://tmux-ide.com/docs";
/// The app icon at 128 px, made with `sips -z 128 128` from
/// apps/tmux-gpui/assets/AppIcon-1024.png.
static ICON: LazyLock<Arc<Image>> = LazyLock::new(|| {
    Arc::new(Image::from_bytes(
        ImageFormat::Png,
        include_bytes!("../../../../assets/about/app-icon-128.png").to_vec(),
    ))
});

#[cfg(feature = "visual-capture")]
thread_local! {
    /// Captures draw About as a release bundle shows it; the capture binary
    /// has no bundle of its own.
    pub(super) static CAPTURE_RELEASE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// The open About card. Holding its focus keeps keys away from the terminal.
pub(super) struct About {
    focus: FocusHandle,
}

/// The bundle's version line: "Version 0.1.16 (2026111101)", or
/// "Development build" outside a release bundle.
pub(super) fn version_line(version: Option<&str>, build: Option<&str>) -> String {
    match (version, build) {
        (Some(version), Some(build)) => format!("Version {version} ({build})"),
        (Some(version), None) => format!("Version {version}"),
        _ => "Development build".into(),
    }
}

/// The release channel a bundle identifier names: the alpha's tag now that
/// the app's name no longer says it.
pub(super) fn channel(bundle_id: Option<&str>) -> Option<&'static str> {
    match bundle_id?.rsplit('.').next()? {
        "alpha" => Some("Alpha"),
        "beta" => Some("Beta"),
        "preview" => Some("Preview"),
        _ => None,
    }
}

/// The row naming what the app is connected to, in plain words.
pub(super) const CONNECTION_LABEL: &str = "Background service";

/// What the [`CONNECTION_LABEL`] row says. A version shows only while the
/// connection that reported it is live, never a stale one.
pub(super) fn connection_line(
    live: Option<&super::diagnostics::Versions>,
    connected: bool,
) -> String {
    match live.and_then(|v| v.daemon_version.as_deref().map(|d| (d, v))) {
        Some((service, versions)) => match versions.tmux_version.as_deref() {
            Some(tmux) => format!("tmux-ide {service} · tmux {tmux}"),
            None => format!("tmux-ide {service}"),
        },
        None if connected => "Connected · open a terminal to see its version".into(),
        None => "Not connected".into(),
    }
}

impl SnapshotView {
    /// Opens the card (the app menu's About item, the palette's row). Another
    /// dialog that holds the keyboard keeps it.
    pub(super) fn open_about(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.pane_close.is_some()
            || self.new_session.is_some()
            || self.pane_actions.is_some()
            || !self.marked.is_empty()
        {
            return;
        }
        if self.picker.is_some() {
            self.close_picker_for_about(window, cx);
        }
        let focus = cx.focus_handle();
        focus.focus(window, cx);
        self.about = Some(About { focus });
        cx.notify();
    }

    pub(super) fn close_about(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.about.take().is_some() {
            self.terminal_focus.focus(window, cx);
            cx.notify();
        }
    }

    /// Escape closes the card; it holds every other key.
    pub(super) fn about_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        cx.stop_propagation();
        window.prevent_default();
        if event.keystroke.key == "escape" && !event.is_held {
            self.close_about(window, cx);
        }
    }

    pub(super) fn about_connection(&self) -> String {
        let connected = self.browser_commands.is_some() && self.presence.ready();
        connection_line(
            self.diagnostics_live()
                .then_some(self.browser_state.diagnostics.as_ref())
                .flatten(),
            connected,
        )
    }

    pub(super) fn about_dialog(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        use bezel_theme::{TextStyle, Typeset as _};
        use bezel_ui::widgets::{Buttons as _, Content as _};
        let about = self.about.as_ref()?;
        let theme = self.theme();
        let bezel = super::design::palette(&theme);
        let muted = super::design::dialog_muted(&theme);
        #[cfg(feature = "visual-capture")]
        let native = if CAPTURE_RELEASE.with(std::cell::Cell::get) {
            super::diagnostics::NativeIdentity {
                version: Some("0.1.16".into()),
                build: Some("2026111101".into()),
                channel: Some("Alpha"),
            }
        } else {
            super::diagnostics::native_identity()
        };
        #[cfg(not(feature = "visual-capture"))]
        let native = super::diagnostics::native_identity();
        let link = |id: &'static str, label: &'static str| {
            bezel
                .ghost(id)
                .debug_selector(move || id.into())
                .role(Role::Link)
                .aria_label(label)
                .h(px(28.))
                .px(px(10.))
                .text_style(TextStyle::Callout)
                .text_color(bezel.accent)
                .child(label)
        };
        let row = |label: &'static str, value: String| {
            // Stacked, so a long version or the not-yet-known note wraps
            // instead of being cut off.
            div()
                .w_full()
                .flex()
                .flex_col()
                .items_center()
                .gap_0p5()
                .text_center()
                .child(
                    div()
                        .text_style(TextStyle::Caption)
                        .text_color(muted)
                        .child(label),
                )
                .child(div().text_style(TextStyle::Callout).child(value))
        };
        let card = bezel_ui::popover::dialog_card(&bezel)
            .id("about-card")
            .debug_selector(|| "about-card".into())
            .track_focus(&about.focus)
            .on_key_down(cx.listener(Self::about_key))
            .role(Role::Dialog)
            .aria_label(format!("About {APP_NAME}"))
            .w(px(360.))
            .max_w_full()
            .items_center()
            .gap_3()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(img(ICON.clone()).size(px(64.)))
            .child(bezel_ui::popover::dialog_title(&bezel, APP_NAME).text_style(TextStyle::Title2))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .text_style(TextStyle::Callout)
                    .text_color(muted)
                    .child(
                        div()
                            .debug_selector(|| "about-version".into())
                            .child(version_line(
                                native.version.as_deref(),
                                native.build.as_deref(),
                            )),
                    )
                    .children(native.channel.map(|channel| {
                        bezel
                            .badge(channel)
                            .text_color(muted)
                            .debug_selector(|| "about-channel".into())
                    })),
            )
            .child(
                div()
                    .w_full()
                    .debug_selector(|| "about-connection".into())
                    .child(row(CONNECTION_LABEL, self.about_connection())),
            )
            .child(
                div()
                    .flex()
                    .gap_1()
                    .child(
                        link("about-website", "Website").on_click(|_, _, cx| cx.open_url(WEBSITE)),
                    )
                    .child(link("about-docs", "Docs").on_click(|_, _, cx| cx.open_url(DOCS)))
                    .child(link("about-changelog", "What’s new").on_click(cx.listener(
                        |view, _, window, cx| {
                            view.close_about(window, cx);
                            view.open_whats_new(window, cx);
                        },
                    ))),
            )
            .child(
                controls::action_button(
                    "about-copy-diagnostics",
                    Some("Copy diagnostics"),
                    "Copy safe error details",
                    Icon::Copy,
                    ButtonStyle::Quiet,
                    &theme,
                )
                .on_click(cx.listener(|view, _, window, cx| {
                    view.close_about(window, cx);
                    view.copy_diagnostics(window, cx);
                })),
            );
        Some(
            super::design::dialog_overlay("about-overlay", &theme)
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(|view, _, window, cx| view.close_about(window, cx)),
                )
                .child(bezel_motion::dialog_in("about-in", card))
                .into_any_element(),
        )
    }
}

#[cfg(test)]
#[path = "about/tests.rs"]
mod tests;
