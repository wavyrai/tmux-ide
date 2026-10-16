//! Explicit, acknowledged local-owner preferences; never terminal input.
use super::*;
use bezel_ui::widgets::{Buttons, Layout};
use browser::fleet::PreferencePhase;
impl SnapshotView {
    fn preference_ready(
        &self,
        request: u64,
        revision: u64,
        action: &str,
        enabled: bool,
        cx: &App,
    ) -> bool {
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
                    && !c.search.read(cx).is_composing()
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
        if !self.preference_ready(request, revision, action, enabled, cx) {
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
        let theme = self.theme();
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
            .is_some_and(|a| self.preference_ready(request, revision, a, enabled_value, cx));
        let palette = super::super::design::palette(&theme);
        let glyph = match icon {
            "icons/chevron-right.svg" => palette.disclosure(false),
            "icons/chevron-down.svg" => palette.disclosure(true),
            _ => bezel_ui::icons::icon(bezel_ui::icons::Icon::asset(icon))
                .size(px(bezel_ui::widgets::ICON_GLYPH))
                .text_color(palette.text_muted),
        };
        let control = if enabled {
            palette.ghost(id)
        } else {
            div().id(id).opacity(0.5)
        };
        control
            .role(Role::Button)
            .aria_label(label)
            .accessibility_id(format!("{}-{}", id.0, id.1))
            .debug_selector(move || format!("{}-{}", id.0, id.1))
            .size(px(28.))
            .p_0()
            .flex_shrink_0()
            .flex()
            .items_center()
            .justify_center()
            .when(!enabled, |d| d.cursor_default())
            .child(glyph)
            .tooltip(move |window, cx| bezel_ui::tooltip::Tooltip::text(label, window, cx))
            .on_click(cx.listener(move |view, _, _, cx| {
                cx.stop_propagation();
                if let Some(action) = &action {
                    view.change_fleet_preference(request, revision, action, enabled_value, cx);
                }
            }))
            .into_any_element()
    }
    pub(in crate::tmux_snapshot) fn fleet_preference_status(&self) -> Option<&str> {
        if self
            .home_filter
            .as_ref()
            .is_some_and(|c| c.preference_error)
        {
            return Some("Preference not queued — try again");
        }
        let p = self.browser_state.fleet.as_ref()?.preferences.as_ref()?;
        match p.phase {
            PreferencePhase::Ready => None,
            PreferencePhase::Loading => Some("Loading fleet preferences…"),
            PreferencePhase::Saving => Some("Saving fleet preferences…"),
            PreferencePhase::Unavailable => Some("Fleet preferences unavailable"),
            PreferencePhase::Failed => Some(
                p.error
                    .as_deref()
                    .unwrap_or("Could not save fleet preferences"),
            ),
        }
    }
}
