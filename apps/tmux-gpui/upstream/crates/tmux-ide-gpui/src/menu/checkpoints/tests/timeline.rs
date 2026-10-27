use crate::menu::checkpoints::timeline::{clock, day_heading, row_height};
use chrono::FixedOffset;

/// 2026-10-08 14:33:00 UTC, a Thursday.
const NOW: i64 = 1_791_469_980;
const DAY: i64 = 86_400;

#[test]
fn clock_times_follow_the_zone() {
    let utc = FixedOffset::east_opt(0).unwrap();
    let paris = FixedOffset::east_opt(2 * 3600).unwrap();
    assert_eq!(clock(NOW, &utc), "14:33");
    assert_eq!(clock(NOW, &paris), "16:33");
    assert_eq!(clock(i64::MAX, &utc), "");
}

#[test]
fn day_headings_name_yesterday_weekdays_and_other_years() {
    let utc = FixedOffset::east_opt(0).unwrap();
    assert_eq!(day_heading(NOW - 3600, NOW, &utc), None);
    assert_eq!(
        day_heading(NOW - DAY, NOW, &utc).as_deref(),
        Some("Yesterday, Oct 7")
    );
    assert_eq!(
        day_heading(NOW - 3 * DAY, NOW, &utc).as_deref(),
        Some("Mon, Oct 5")
    );
    assert_eq!(
        day_heading(NOW - 365 * DAY, NOW, &utc).as_deref(),
        Some("Oct 8, 2025")
    );
    // The zone decides the day: 04:33 UTC is today, but yesterday in Kiritimati.
    let kiritimati = FixedOffset::east_opt(14 * 3600).unwrap();
    assert_eq!(day_heading(NOW - 10 * 3600, NOW, &utc), None);
    assert_eq!(
        day_heading(NOW - 10 * 3600, NOW, &kiritimati).as_deref(),
        Some("Yesterday, Oct 8")
    );
}

#[test]
fn rows_grow_with_the_terminal_font() {
    let mut face = crate::config::Config::default().terminal;
    face.size = 14.;
    face.line_height_multiple = None;
    assert_eq!(row_height(&face), 26.);
    // The largest size Settings allows still leaves air around the text.
    face.size = *crate::config::FONT_SIZE_RANGE.end();
    assert!(row_height(&face) >= face.line_height() + 6.);
    face.line_height_multiple = Some(2.);
    assert!(row_height(&face) >= face.size * 2. + 6.);
}

// Host scripts need a POSIX client, so other clients offer no dialog.
#[cfg(any(target_os = "linux", target_os = "macos"))]
#[gpui::test]
fn a_day_break_starts_each_earlier_day(cx: &mut gpui::TestAppContext) {
    use super::local;
    use crate::checkpoint::{Checkpoint, Diff, Listing};
    let now: i64 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        .try_into()
        .unwrap();
    let checkpoint = |id: &str, created: i64, files: u64| Checkpoint {
        id: id.into(),
        created,
        label: format!("turn {id}"),
        branch: Some("worktree/sidebar-child".into()),
        diff: Diff {
            files,
            additions: files * 3,
            deletions: files,
        },
    };
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            local(view);
            // The largest terminal font, so rows must grow to hold it.
            view.config.terminal.size = *crate::config::FONT_SIZE_RANGE.end();
            view.open_workspace_menu("w4", Default::default(), window, cx);
            view.activate_workspace_menu(
                crate::menu::page::WorkspaceMenuAction::Checkpoints,
                window,
                cx,
            );
            // Days far enough apart that no zone or midnight puts two on
            // the same date, and two sharing one timestamp.
            view.checkpoints.view.as_mut().unwrap().listing = Listing::Ready(vec![
                checkpoint("3", now - 3 * DAY, 2),
                checkpoint("2", now - 3 * DAY, 0),
                checkpoint("1", now - 10 * DAY, 1),
            ]);
        })
    });
    cx.run_until_parked();
    assert!(cx.debug_bounds("checkpoint-day-0").is_some());
    assert!(cx.debug_bounds("checkpoint-day-1").is_none());
    assert!(cx.debug_bounds("checkpoint-day-2").is_some());
    // Every line is the same height, and its restore icon sits inside it.
    let first = cx.debug_bounds("checkpoint-0").unwrap();
    let second = cx.debug_bounds("checkpoint-1").unwrap();
    assert_eq!(first.size.height, second.size.height);
    let face = cx.update(|_, cx| view.read(cx).config.terminal.clone());
    assert_eq!(first.size.height, gpui::px(row_height(&face)));
    let icon = cx.debug_bounds("checkpoint-restore-0").unwrap();
    assert!(first.contains(&icon.center()));
    // Clicking the icon asks before restoring.
    cx.simulate_click(icon.center(), gpui::Modifiers::default());
    cx.update(|_, cx| {
        let view = view.read(cx).checkpoints.view.as_ref().unwrap();
        assert_eq!(view.confirming.as_deref(), Some("3"));
    });
}
