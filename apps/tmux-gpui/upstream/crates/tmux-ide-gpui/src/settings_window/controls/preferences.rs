use super::*;
use crate::config::{ClipboardToastPosition as ClipboardPosition, preferences::Preference};
use herdr_client::protocol::ToastHerdrPosition as Position;

#[cfg(test)]
#[derive(Clone)]
pub(super) struct PreferenceIo {
    pub(super) write: std::sync::Arc<dyn Fn(Preference) -> crate::Result<()> + Send + Sync>,
    pub(super) load: fn() -> crate::Result<super::super::Loaded>,
}

impl SettingsWindow {
    pub(super) fn save_preference(&mut self, edit: Preference, cx: &mut Context<Self>) {
        #[cfg(test)]
        if let Some(io) = self.controls.preference_io.clone() {
            self.save_with(move || (io.write)(edit), io.load, false, cx);
            return;
        }
        self.save_native(move || Config::save_preference(edit), cx);
    }
    pub(in crate::settings_window) fn render_integration_controls(
        &self,
        cx: &mut Context<Self>,
    ) -> Div {
        let query = self.controls.integration_search.read(cx).text().to_owned();
        div().flex().flex_col().gap(px(16.))
            .child(self.controls.integration_search.clone())
            .child(self.source.update(cx, |source, cx| source.render_filtered_integrations(&query, cx))
                .unwrap_or_else(|_| div().child("Open a session window to manage agent integrations. Local preferences remain available.")))
    }

    pub(in crate::settings_window) fn control_switch(
        &self,
        id: impl Into<SharedString>,
        label: impl Into<SharedString>,
        checked: bool,
        enabled: bool,
    ) -> Stateful<Div> {
        let id = id.into();
        div()
            .id(ElementId::Name(id.clone()))
            .debug_selector(move || id.to_string())
            .flex()
            .items_center()
            .justify_between()
            .gap(px(12.))
            .py(px(8.))
            .when(enabled, |row| row.cursor_pointer())
            .when(!enabled, |row| row.opacity(0.5))
            .child(label.into())
            .child(crate::toggles::switch(&self.theme, 22., checked))
    }

    pub(super) fn preference_switch(
        &self,
        id: &'static str,
        label: &'static str,
        checked: bool,
        edit: Preference,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        self.control_switch(id, label, checked, true)
            .on_click(cx.listener(move |this, _, _, cx| this.save_preference(edit, cx)))
    }

    fn preference_choice(
        &self,
        id: impl Into<SharedString>,
        label: impl Into<SharedString>,
        selected: bool,
        edit: Preference,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        self.control_choice(id, label.into(), selected, true)
            .on_click(cx.listener(move |this, _, _, cx| this.save_preference(edit, cx)))
    }

    pub(super) fn native_notification_controls(&self, cx: &mut Context<Self>) -> Div {
        let config = self.config.notifications;
        let mut positions = div().flex().flex_wrap().gap(px(8.));
        for (label, position) in [
            ("Top left", Position::TopLeft),
            ("Top right", Position::TopRight),
            ("Bottom left", Position::BottomLeft),
            ("Bottom right", Position::BottomRight),
        ] {
            positions = positions.child(self.preference_choice(
                format!("notification-{label}"),
                label,
                config.position == position,
                Preference::NotificationPosition(Some(position)),
                cx,
            ));
        }
        self.control_card("Native notification overrides")
            .child(self.preference_switch("settings-notification-enabled", "In-app notifications", config.enabled, Preference::NotificationEnabled(Some(!config.enabled)), cx))
            .child(self.preference_choice("notification-follow-enabled", "Follow shared delivery", false, Preference::NotificationEnabled(None), cx))
            .child(self.control_row("Delay", format!("{} seconds (0-3600)", config.delay_seconds)))
            .child(div().flex().flex_wrap().gap(px(8.))
                .child(self.preference_choice("notification-delay-minus", "-1 second", false, Preference::NotificationDelay(Some(config.delay_seconds.saturating_sub(1))), cx))
                .child(self.preference_choice("notification-delay-plus", "+1 second", false, Preference::NotificationDelay(Some((config.delay_seconds + 1).min(3600))), cx))
                .child(self.preference_choice("notification-follow-delay", "Follow shared delay", false, Preference::NotificationDelay(None), cx)))
            .child(self.control_note("Position"))
            .child(positions)
            .child(self.preference_choice("notification-follow-position", "Follow shared position", false, Preference::NotificationPosition(None), cx))
            .child(self.control_note("Controls show effective values. Follow shared removes that local override; any managed-file override still takes precedence."))
    }

    pub(super) fn clipboard_controls(&self, cx: &mut Context<Self>) -> Div {
        let config = self.config.clipboard_toast;
        let mut positions = div().flex().flex_wrap().gap(px(8.));
        for (label, position) in [
            ("Top left", ClipboardPosition::TopLeft),
            ("Top center", ClipboardPosition::TopCenter),
            ("Top right", ClipboardPosition::TopRight),
            ("Bottom left", ClipboardPosition::BottomLeft),
            ("Bottom center", ClipboardPosition::BottomCenter),
            ("Bottom right", ClipboardPosition::BottomRight),
        ] {
            positions = positions.child(self.preference_choice(
                format!("clipboard-{label}"),
                label,
                config.position == position,
                Preference::ClipboardPosition(Some(position)),
                cx,
            ));
        }
        self.control_card("Clipboard feedback")
            .child(self.preference_switch(
                "settings-clipboard-enabled",
                "Copied notification",
                config.enabled,
                Preference::ClipboardEnabled(Some(!config.enabled)),
                cx,
            ))
            .child(self.preference_choice(
                "clipboard-follow-enabled",
                "Follow shared enablement",
                false,
                Preference::ClipboardEnabled(None),
                cx,
            ))
            .child(self.control_note("Position"))
            .child(positions)
            .child(self.preference_choice(
                "clipboard-follow-position",
                "Follow shared position",
                false,
                Preference::ClipboardPosition(None),
                cx,
            ))
    }

    pub(super) fn sidebar_gap_control(&self, cx: &mut Context<Self>) -> Div {
        let gap = self.config.layout.sidebar_gap;
        div()
            .child(self.control_row("Sidebar gap", format!("{gap} px (0-64)")))
            .child(
                div()
                    .flex()
                    .gap(px(8.))
                    .child(self.preference_choice(
                        "sidebar-gap-minus",
                        "-1 px",
                        false,
                        Preference::SidebarGap((gap - 1.).max(0.)),
                        cx,
                    ))
                    .child(self.preference_choice(
                        "sidebar-gap-plus",
                        "+1 px",
                        false,
                        Preference::SidebarGap((gap + 1.).min(64.)),
                        cx,
                    )),
            )
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use core::prelude::v1::test;
    use std::sync::{Arc, Mutex};

    #[gpui::test]
    fn switches_route_typed_edits_and_preserve_layout_drafts(cx: &mut TestAppContext) {
        let (view, cx) = cx.add_window_view(super::super::tests::skill_fixture);
        let edits = Arc::new(Mutex::new(Vec::new()));
        let captured = edits.clone();
        view.update(cx, |view, cx| {
            view.controls.preference_io = Some(PreferenceIo {
                write: Arc::new(move |edit| {
                    captured.lock().unwrap().push(edit);
                    Ok(())
                }),
                load: super::super::tests::skill_load,
            });
            view.accept_layout_choice(LayoutMode::Orca, cx);
        });
        cx.simulate_resize(size(px(960.), px(2200.)));
        for (section, selector, edit) in [
            (
                Section::General,
                "settings-confirm-close",
                Preference::ConfirmCloseTab(false),
            ),
            (
                Section::General,
                "settings-confirm-close-pane",
                Preference::ConfirmClosePane(false),
            ),
            (
                Section::General,
                "settings-clipboard-enabled",
                Preference::ClipboardEnabled(Some(false)),
            ),
            (
                Section::Notifications,
                "settings-notification-enabled",
                Preference::NotificationEnabled(Some(true)),
            ),
        ] {
            view.update(cx, |view, cx| {
                view.section = section;
                cx.notify();
            });
            cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
            let point = cx.debug_bounds(selector).unwrap().center();
            cx.simulate_click(point, Default::default());
            cx.run_until_parked();
            assert_eq!(edits.lock().unwrap().last(), Some(&edit));
            view.read_with(cx, |view, _| {
                assert!(!view.busy());
                assert_eq!(view.config.layout.mode, LayoutMode::Orca);
                assert_eq!(view.layout_intent, Some(LayoutMode::Orca));
            });
            let count = edits.lock().unwrap().len();
            view.update(cx, |view, cx| {
                view.saving = true;
                cx.notify();
            });
            cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
            let point = cx.debug_bounds(selector).unwrap().center();
            cx.simulate_click(point, Default::default());
            cx.run_until_parked();
            assert_eq!(edits.lock().unwrap().len(), count);
            view.update(cx, |view, _| view.saving = false);
        }
    }
}
