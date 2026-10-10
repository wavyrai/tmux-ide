//! Settings > Status bar: a switch per item, and how compactly a shown item
//! draws. Usage and CPU/memory keep their existing visibility keys, which
//! also stop their sampling.
use super::*;
use crate::config::{
    preferences::Preference,
    status_bar::{Button, Detail, Edit},
};

impl SettingsWindow {
    pub(super) fn render_status_bar_controls(&self, cx: &mut Context<Self>) -> Div {
        let items = self.config.status_bar;
        let usage = self.config.usage.show;
        let system_load = self.config.show_system_load;
        self.control_card("Items")
            .child(
                self.control_switch("settings-usage", "Usage", usage, true)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.save_native(move || Config::save_usage_visibility(!usage), cx);
                    })),
            )
            .child(self.detail_choices(
                ["settings-usage-detailed", "settings-usage-compact"],
                items.usage,
                usage,
                Edit::Usage,
                cx,
            ))
            .child(self.control_note(
                "Compact shows each service's tightest limit as one share; the full view adds a meter and its two tightest windows.",
            ))
            .child(self.preference_switch(
                "settings-system-load",
                "CPU and memory",
                system_load,
                Preference::ShowSystemLoad(!system_load),
                cx,
            ))
            .child(self.detail_choices(
                ["settings-system-load-detailed", "settings-system-load-compact"],
                items.system_load,
                system_load,
                Edit::SystemLoad,
                cx,
            ))
            .child(self.control_note(
                "Hiding CPU and memory also removes them from sidebar host rows.",
            ))
            .child(self.preference_switch(
                "settings-status-keep-awake",
                "Keep display awake",
                items.keep_awake,
                Preference::StatusBar(Edit::KeepAwake(!items.keep_awake)),
                cx,
            ))
            .child(self.button_controls(
                [
                    "settings-status-theme",
                    "settings-status-theme-label",
                    "settings-status-theme-icon",
                ],
                "Theme",
                items.theme,
                Edit::Theme,
                cx,
            ))
            .child(self.button_controls(
                [
                    "settings-status-shortcuts",
                    "settings-status-shortcuts-label",
                    "settings-status-shortcuts-icon",
                ],
                "Shortcuts",
                items.shortcuts,
                Edit::Shortcuts,
                cx,
            ))
            .child(self.button_controls(
                [
                    "settings-status-report-issue",
                    "settings-status-report-issue-label",
                    "settings-status-report-issue-icon",
                ],
                "Report issue",
                items.report_issue,
                Edit::ReportIssue,
                cx,
            ))
            .child(self.control_note(
                "Listening ports are under General. The version stays, since it says when an update is ready.",
            ))
    }

    fn detail_choices(
        &self,
        ids: [&'static str; 2],
        current: Detail,
        enabled: bool,
        edit: fn(Detail) -> Edit,
        cx: &mut Context<Self>,
    ) -> Div {
        let [detailed, compact] = ids;
        self.status_choices(
            [
                (detailed, "Detailed", Detail::Detailed),
                (compact, "Compact", Detail::Compact),
            ],
            current,
            enabled,
            edit,
            cx,
        )
    }

    /// A switch that hides the button, then whether it keeps its name.
    /// `ids` name the switch, then the label and icon-only choices.
    fn button_controls(
        &self,
        ids: [&'static str; 3],
        label: &'static str,
        current: Button,
        edit: fn(Button) -> Edit,
        cx: &mut Context<Self>,
    ) -> Div {
        let [switch, labelled, icon] = ids;
        let shown = current.shown();
        let toggled = if shown { Button::Hidden } else { Button::Label };
        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(self.preference_switch(
                switch,
                label,
                shown,
                Preference::StatusBar(edit(toggled)),
                cx,
            ))
            .child(self.status_choices(
                [
                    (labelled, "With label", Button::Label),
                    (icon, "Icon only", Button::Icon),
                ],
                current,
                shown,
                edit,
                cx,
            ))
    }

    fn status_choices<T: Copy + PartialEq + 'static>(
        &self,
        choices: [(&'static str, &'static str, T); 2],
        current: T,
        enabled: bool,
        edit: fn(T) -> Edit,
        cx: &mut Context<Self>,
    ) -> Div {
        let mut row = div().flex().flex_wrap().gap(px(8.));
        for (id, label, choice) in choices {
            let selected = enabled && current == choice;
            row = row.child(
                self.control_choice(id, label, selected, enabled)
                    .debug_selector(move || id.into())
                    .when(enabled && !selected, |button| {
                        button.on_click(cx.listener(move |this, _, _, cx| {
                            this.save_preference(Preference::StatusBar(edit(choice)), cx);
                        }))
                    }),
            );
        }
        row
    }
}

#[cfg(test)]
mod tests;
