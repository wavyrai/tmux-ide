#![allow(clippy::unwrap_used)]

use super::*;
use crate::settings_window::controls::{
    preferences::PreferenceIo,
    tests::{skill_fixture, skill_load},
};
use core::prelude::v1::test;
use gpui::VisualTestContext;
use std::sync::{Arc, Mutex};

#[gpui::test]
fn status_bar_controls_save_typed_edits(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(skill_fixture);
    let edits = Arc::new(Mutex::new(Vec::new()));
    let captured = edits.clone();
    view.update(cx, |view, _| {
        view.section = Section::StatusBar;
        view.controls.preference_io = Some(PreferenceIo {
            write: Arc::new(move |edit| {
                captured.lock().unwrap().push(edit);
                Ok(())
            }),
            load: skill_load,
        });
    });
    cx.simulate_resize(size(px(960.), px(2200.)));
    let click = |cx: &mut VisualTestContext, selector: &'static str| {
        cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
        let point = cx.debug_bounds(selector).unwrap().center();
        cx.simulate_click(point, Default::default());
        cx.run_until_parked();
        edits.lock().unwrap().pop()
    };
    for (selector, edit) in [
        ("settings-usage-compact", Edit::Usage(Detail::Compact)),
        (
            "settings-system-load-compact",
            Edit::SystemLoad(Detail::Compact),
        ),
        ("settings-status-keep-awake", Edit::KeepAwake(false)),
        ("settings-status-theme", Edit::Theme(Button::Hidden)),
        ("settings-status-theme-icon", Edit::Theme(Button::Icon)),
        (
            "settings-status-shortcuts-icon",
            Edit::Shortcuts(Button::Icon),
        ),
        (
            "settings-status-report-issue",
            Edit::ReportIssue(Button::Hidden),
        ),
    ] {
        assert_eq!(
            click(cx, selector),
            Some(Preference::StatusBar(edit)),
            "{selector}"
        );
    }
    assert_eq!(
        click(cx, "settings-system-load"),
        Some(Preference::ShowSystemLoad(false))
    );
    // The current choice, and the choices of a hidden item, save nothing.
    assert_eq!(click(cx, "settings-usage-detailed"), None);
    view.update(cx, |view, cx| {
        view.config.status_bar.theme = Button::Hidden;
        cx.notify();
    });
    assert_eq!(click(cx, "settings-status-theme-icon"), None);
    assert_eq!(
        click(cx, "settings-status-theme"),
        Some(Preference::StatusBar(Edit::Theme(Button::Label)))
    );
}
