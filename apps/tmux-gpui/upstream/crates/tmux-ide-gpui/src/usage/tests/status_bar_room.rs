//! How much of the status bar usage takes, and the room other items give up.
use super::*;
use crate::config::status_bar::{Button, Detail};
use crate::sidebar::layout_tests::{fixture_window, full_draw};
use gpui::{TestAppContext, px, size};

fn named(name: &str, used: f64) -> Window {
    Window::new(Kind::Named(name.into()), used, None, None)
}

/// Antigravity's shape: a 5-hour and a weekly quota per model family.
fn antigravity() -> Reading {
    let provider = provider("antigravity");
    Reading {
        provider,
        report: Some(Report::new(
            provider,
            Account::default(),
            vec![
                named("Claude/GPT 5-hour", 40.),
                named("Claude/GPT weekly", 10.),
                named("Gemini 5-hour", 70.),
                named("Gemini weekly", 20.),
            ],
        )),
        error: None,
        access: None,
    }
}

#[test]
fn a_detailed_segment_names_its_two_tightest_windows_in_report_order() {
    let windows = [
        named("a", 40.),
        named("b", 10.),
        named("c", 70.),
        named("d", 20.),
    ];
    let names = |windows: &[Window]| {
        super::super::render::bar_windows(windows)
            .map(|window| window.kind.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(
        names(&windows),
        [Kind::Named("a".into()), Kind::Named("c".into())]
    );
    // Ties keep report order, and fewer windows than room show them all.
    let even = [named("a", 5.), named("b", 5.), named("c", 5.)];
    assert_eq!(
        names(&even),
        [Kind::Named("a".into()), Kind::Named("b".into())]
    );
    assert_eq!(names(&even[..1]), [Kind::Named("a".into())]);
    assert!(names(&[]).is_empty());
}

#[gpui::test]
fn compact_usage_and_icon_buttons_give_the_bar_back(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        view.config.usage.show = true;
        view.usage.host = Some(super::super::Host::Local);
        view.usage.entries.insert(
            super::super::Host::Local,
            super::super::Entry {
                readings: vec![antigravity()],
                ..Default::default()
            },
        );
        view
    });
    cx.simulate_resize(size(px(1280.), px(600.)));
    let mut measure = |change: &dyn Fn(&mut crate::config::StatusBar)| {
        view.update(cx, |view, cx| {
            change(&mut view.config.status_bar);
            cx.notify();
        });
        cx.update(|window, cx| full_draw(window, cx).clear(cx));
        let mut width = |selector| cx.debug_bounds(selector).map(|bounds| bounds.size.width);
        (
            width("usage-antigravity"),
            width("status-theme"),
            width("status-keybinds"),
            width("report-issue"),
            width("status-caffeine"),
        )
    };
    let (detailed, theme, shortcuts, report, caffeine) = measure(&|_| {});
    let detailed = detailed.unwrap();
    let (compact, ..) = measure(&|bar| bar.usage = Detail::Compact);
    let compact = compact.unwrap();
    assert!(compact < detailed);
    // An icon and one share, whatever the service's window names.
    assert!(compact < px(60.), "compact usage is {compact:?}");
    assert!(caffeine.is_some());

    let (_, theme_icon, shortcuts_icon, report_icon, _) = measure(&|bar| {
        bar.theme = Button::Icon;
        bar.shortcuts = Button::Icon;
        bar.report_issue = Button::Icon;
    });
    for (label, icon) in [
        (theme, theme_icon),
        (shortcuts, shortcuts_icon),
        (report, report_icon),
    ] {
        assert!(icon.unwrap() < label.unwrap());
    }

    let hidden = measure(&|bar| {
        bar.theme = Button::Hidden;
        bar.shortcuts = Button::Hidden;
        bar.report_issue = Button::Hidden;
        bar.keep_awake = false;
    });
    assert!(hidden.0.is_some());
    assert_eq!(
        (hidden.1, hidden.2, hidden.3, hidden.4),
        (None, None, None, None)
    );
    assert!(cx.debug_bounds("status-version").is_some());
}
