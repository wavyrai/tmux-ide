//! Explicit, acknowledged local-owner preferences; never terminal input.
use super::*;
use browser::fleet::PreferencePhase;
impl SnapshotView {
    fn preference_ready(&self, request: u64, revision: u64, action: &str, enabled: bool) -> bool {
        self.browser_request == request
            && self.browser_state.request == request
            && matches!(
                self.browser_state.surface,
                browser::Surface::Home | browser::Surface::Workspace
            )
            && self.browser_commands.is_some()
            && self.presence.ready()
            && self.picker.is_none()
            && self.new_session.is_none()
            && self.pane_actions.is_none()
            && self.marked.is_empty()
            && self.home_filter.as_ref().is_some_and(|c| {
                c.preference_queued
                    != Some((request, revision, self.browser_state.presence_revision))
            })
            && self
                .browser_state
                .fleet
                .as_ref()
                .is_some_and(|f| f.preference_action(revision, action, enabled))
    }
    pub(in crate::tmux_snapshot) fn change_fleet_preference(
        &mut self,
        request: u64,
        revision: u64,
        action: &str,
        enabled: bool,
        cx: &mut Context<Self>,
    ) {
        if !self.preference_ready(request, revision, action, enabled) {
            return;
        }
        let queued = self.browser_commands.as_ref().is_some_and(|sender| {
            sender
                .try_send(browser::Command::FleetPreference {
                    request,
                    revision,
                    action: action.into(),
                    enabled,
                })
                .is_ok()
        });
        if let Some(c) = &mut self.home_filter {
            c.preference_error = !queued;
            if queued {
                c.preference_queued =
                    Some((request, revision, self.browser_state.presence_revision));
            }
        }
        cx.notify();
    }
    pub(in crate::tmux_snapshot) fn fleet_preference_button(
        &self,
        id: (&'static str, usize),
        action: Option<&str>,
        enabled_value: bool,
        label: &'static str,
        icon: &'static str,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let request = self.browser_request;
        let revision = self
            .browser_state
            .fleet
            .as_ref()
            .and_then(|f| f.preferences.as_ref())
            .map_or(0, |p| p.revision);
        let action = action.map(str::to_owned);
        let enabled = action
            .as_ref()
            .is_some_and(|a| self.preference_ready(request, revision, a, enabled_value));
        let palette = self.home_palette();
        // Bezel's button owns the disabled state: no tab stop, no activation,
        // its faded paint. The glyph keeps Home's inked muted.
        let button = bezel_ui::widgets::Button::new(id, label)
            .icon(bezel_ui::icons::Icon::asset(icon))
            .label_hidden()
            .enabled(enabled)
            .text_color(palette.text_muted)
            .on_press(cx.listener(move |view, _, _, cx| {
                cx.stop_propagation();
                if let Some(action) = &action {
                    view.change_fleet_preference(request, revision, action, enabled_value, cx);
                }
            }));
        div()
            .id(SharedString::from(format!("{}-{}-tip", id.0, id.1)))
            .accessibility_id(format!("{}-{}", id.0, id.1))
            .debug_selector(move || format!("{}-{}", id.0, id.1))
            .flex_shrink_0()
            .child(
                div()
                    .debug_selector(move || {
                        let state = if enabled { "enabled" } else { "disabled" };
                        format!("{}-{}-{state}", id.0, id.1)
                    })
                    .child(button),
            )
            .when(enabled, |tip| {
                tip.tooltip(move |window, cx| bezel_ui::tooltip::Tooltip::text(label, window, cx))
            })
            .into_any_element()
    }
    /// Saving progress, or why a preference did not apply.
    pub(in crate::tmux_snapshot) fn fleet_preference_status(&self) -> Option<Status<'_>> {
        if self
            .home_filter
            .as_ref()
            .is_some_and(|c| c.preference_error)
        {
            return Some(Status::Error("Preference not queued — try again"));
        }
        let p = self.browser_state.fleet.as_ref()?.preferences.as_ref()?;
        match p.phase {
            PreferencePhase::Ready => None,
            PreferencePhase::Loading => Some(Status::Progress("Loading fleet preferences…")),
            PreferencePhase::Saving => Some(Status::Progress("Saving fleet preferences…")),
            PreferencePhase::Unavailable => Some(Status::Error("Fleet preferences unavailable")),
            PreferencePhase::Failed => Some(Status::Error(
                p.error
                    .as_deref()
                    .unwrap_or("Could not save fleet preferences"),
            )),
        }
    }
}

/// What [`SnapshotView::fleet_preference_status`] reports.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::tmux_snapshot) enum Status<'a> {
    Progress(&'a str),
    Error(&'a str),
}
impl<'a> Status<'a> {
    pub(in crate::tmux_snapshot) fn message(self) -> &'a str {
        match self {
            Self::Progress(message) | Self::Error(message) => message,
        }
    }
}
