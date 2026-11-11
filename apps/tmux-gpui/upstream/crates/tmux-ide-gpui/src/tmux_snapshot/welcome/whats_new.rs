//! What's new, once per version (onboarding A5): a small card on Home the
//! first time a version runs, from the same per-version list Commands →
//! What's new shows in full.
use super::*;
use bezel_theme::{TextStyle, Typeset as _};
use bezel_ui::widgets::{ButtonStyle, Buttons as _};

/// The changes, newest first. A version's own entry is what its card shows;
/// "Earlier" collects what came before versions were listed.
pub(in crate::tmux_snapshot) const RELEASES: &[(&str, &[&str])] = &[
    (
        "0.1.17",
        &[
            "A welcome screen sets Tmux IDE up in one click.",
            "Setup and connection problems say what happened in plain words.",
            "About Tmux IDE, in the Tmux IDE menu, shows the versions of the app, the background service and tmux.",
            "What's new shows once after each update, like this.",
        ],
    ),
    (
        "Earlier",
        &[
            "Home and machines · Agent search, machine filters, observation retry and load more, plus saved-machine management.",
            "Workspace · New terminal windows and named Claude or Codex agents; pane rename, split, zoom and confirmed close.",
            "Native controls · Pane header menus, sidebar visibility, searchable Commands and keyboard reference popovers.",
            "Terminal font · Installed family selection, size controls and automatic symbol fallbacks, saved for the next launch.",
        ],
    ),
];
/// The notes for exactly `version`, if it has any.
pub(in crate::tmux_snapshot) fn notes(version: &str) -> Option<&'static [&'static str]> {
    RELEASES
        .iter()
        .find(|(v, _)| *v == version && *v != "Earlier")
        .map(|(_, notes)| *notes)
}
/// The card shows once a version: for someone welcomed (or already set up),
/// with the welcome closed, the first time this version has notes.
pub(in crate::tmux_snapshot) fn due(welcome: &State) -> Option<&'static [&'static str]> {
    if !welcome.ready || !welcome.welcomed || welcome.open {
        return None;
    }
    let version = welcome.version.as_deref()?;
    if welcome.whats_new_seen.as_deref() == Some(version) {
        return None;
    }
    notes(version)
}

impl SnapshotView {
    pub(in crate::tmux_snapshot) fn close_whats_new(&mut self, cx: &mut Context<Self>) {
        self.welcome.whats_new_seen = self.welcome.version.clone();
        self.save_welcome(cx);
        cx.notify();
    }
    pub(in crate::tmux_snapshot) fn whats_new_card(
        &self,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        use bezel_ui::surface::Surfaced as _;
        let notes = due(&self.welcome)?;
        let version = self.welcome.version.clone()?;
        let bezel = super::super::glass_ink::on_regular_glass(&self.home_palette());
        let title = format!("What's new in Tmux IDE {version}");
        Some(
            bezel_ui::popover::popover_card(&bezel)
                .id("whats-new")
                .debug_selector(|| "whats-new".into())
                .role(Role::Dialog)
                .aria_label(title.clone())
                .absolute()
                .right(px(24.))
                .bottom(px(24.))
                .w(px(340.))
                .p(px(14.))
                .flex()
                .flex_col()
                .gap(px(8.))
                .occlude()
                .text_color(bezel.text)
                .child(
                    div()
                        .debug_selector(|| "whats-new-title".into())
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(title),
                )
                .children(notes.iter().enumerate().map(|(index, note)| {
                    div()
                        .debug_selector(move || format!("whats-new-note-{index}"))
                        .flex()
                        .gap(px(6.))
                        .text_style(TextStyle::Callout)
                        .child("•")
                        .child(div().flex_1().min_w_0().child(*note))
                }))
                .child(
                    div()
                        .flex()
                        .justify_end()
                        .gap(px(8.))
                        .child(
                            bezel
                                .button("See everything", ButtonStyle::Ghost, None)
                                .id("whats-new-all")
                                .debug_selector(|| "whats-new-all".into())
                                .role(Role::Button)
                                .aria_label("See everything")
                                .cursor_pointer()
                                .on_click(cx.listener(|view, _, window, cx| {
                                    cx.stop_propagation();
                                    view.close_whats_new(cx);
                                    view.open_whats_new(window, cx);
                                })),
                        )
                        .child(
                            bezel
                                .button("Close", ButtonStyle::Ghost, None)
                                .id("whats-new-close")
                                .debug_selector(|| "whats-new-close".into())
                                .role(Role::Button)
                                .aria_label("Close What's new")
                                .cursor_pointer()
                                .on_click(cx.listener(|view, _, _, cx| {
                                    cx.stop_propagation();
                                    view.close_whats_new(cx);
                                })),
                        ),
                )
                .surface(&bezel, bezel.popover_surface)
                .into_any_element(),
        )
    }
}
