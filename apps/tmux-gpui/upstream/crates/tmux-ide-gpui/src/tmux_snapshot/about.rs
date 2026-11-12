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

/// The open About card. Holding its focus keeps keys away from the terminal;
/// the window gives it back on render if anything else took it.
pub(super) struct About {
    focus: FocusHandle,
    /// What had the keyboard before (a dialog, the welcome, the terminal),
    /// which gets it back when the card closes.
    restore: Option<FocusHandle>,
    /// The control Tab has reached, if any; Return or Space acts on it.
    pub(super) focused: Option<usize>,
}

impl About {
    pub(super) fn holds_focus(&self, window: &Window) -> bool {
        self.focus.is_focused(window)
    }
    pub(super) fn take_focus(&self, window: &mut Window, cx: &mut App) {
        self.focus.focus(window, cx);
    }
}

/// The card's controls, in Tab order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Control {
    Website,
    Docs,
    WhatsNew,
    CopyDiagnostics,
}

impl Control {
    pub(super) const ALL: [Self; 4] = [
        Self::Website,
        Self::Docs,
        Self::WhatsNew,
        Self::CopyDiagnostics,
    ];
}

/// The control Tab (or Shift-Tab, `back`) moves to from `from`, wrapping.
pub(super) fn step(from: Option<usize>, back: bool) -> usize {
    let n = Control::ALL.len();
    match (from, back) {
        (None, false) => 0,
        (None, true) => n - 1,
        (Some(i), false) => (i + 1) % n,
        (Some(i), true) => (i + n - 1) % n,
    }
}

/// The bundle's version line: "Version 0.1.17 (2026111201)", or
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
    /// Opens the card (the app menu's About item, the palette's row) over
    /// whatever is open, which keeps its state and gets the keyboard back on
    /// close. The pane cards and a composition in progress keep the keyboard.
    pub(super) fn open_about(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.about.is_some()
            || self.pane_close.is_some()
            || self.new_session.is_some()
            || self.pane_actions.is_some()
            || !self.marked.is_empty()
        {
            return;
        }
        let restore = window.focused(cx);
        let focus = cx.focus_handle();
        focus.focus(window, cx);
        self.about = Some(About {
            focus,
            restore,
            focused: None,
        });
        cx.notify();
    }

    pub(super) fn close_about(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(about) = self.about.take() {
            about
                .restore
                .unwrap_or_else(|| self.terminal_focus.clone())
                .focus(window, cx);
            cx.notify();
        }
    }

    /// Escape closes the card, Tab and Shift-Tab move between its controls,
    /// Return and Space act on the one reached; it holds every other key.
    pub(super) fn about_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        cx.stop_propagation();
        window.prevent_default();
        let key = &event.keystroke;
        let m = &key.modifiers;
        if event.is_held || m.platform || m.control || m.alt {
            return;
        }
        let Some(about) = self.about.as_mut() else {
            return;
        };
        match key.key.as_str() {
            "escape" => self.close_about(window, cx),
            "tab" => {
                about.focused = Some(step(about.focused, m.shift));
                cx.notify();
            }
            "enter" | "space" => {
                if let Some(control) = about.focused.and_then(|i| Control::ALL.get(i).copied()) {
                    self.about_activate(control, window, cx);
                }
            }
            _ => {}
        }
    }

    pub(super) fn about_activate(
        &mut self,
        control: Control,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match control {
            Control::Website => cx.open_url(WEBSITE),
            Control::Docs => cx.open_url(DOCS),
            Control::WhatsNew => {
                self.close_about(window, cx);
                self.open_whats_new(window, cx);
            }
            Control::CopyDiagnostics => {
                self.close_about(window, cx);
                self.copy_diagnostics(window, cx);
            }
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
                version: Some("0.1.17".into()),
                build: Some("2026111201".into()),
                channel: Some("Alpha"),
            }
        } else {
            super::diagnostics::native_identity()
        };
        #[cfg(not(feature = "visual-capture"))]
        let native = super::diagnostics::native_identity();
        let ring = |control: Control| {
            if about.focused.and_then(|i| Control::ALL.get(i)) == Some(&control) {
                bezel.ring
            } else {
                transparent_black()
            }
        };
        let link = |id: &'static str, label: &'static str, control: Control| {
            bezel
                .ghost(id)
                .border_1()
                .border_color(ring(control))
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
                div().flex().gap_1().children(
                    [
                        ("about-website", "Website", Control::Website),
                        ("about-docs", "Docs", Control::Docs),
                        ("about-changelog", "What’s new", Control::WhatsNew),
                    ]
                    .map(|(id, label, control)| {
                        link(id, label, control).on_click(cx.listener(
                            move |view, _, window, cx| view.about_activate(control, window, cx),
                        ))
                    }),
                ),
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
                .border_color(ring(Control::CopyDiagnostics))
                .on_click(cx.listener(|view, _, window, cx| {
                    view.about_activate(Control::CopyDiagnostics, window, cx)
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
