//! Project headings and pane rows (#746) in the row ink, on the frosted sidebar.
use super::super::text_role_tests::{catalog, plates, worst};
use super::*;
use crate::tmux_snapshot::design::{InkProbes, row_ink};
use gpui::Hsla;

/// A heading is set in the row caption ink and a pane row in the row label
/// ink, each at 4.5:1 on the sidebar and under its washes, in every catalog
/// variant.
#[gpui::test]
fn headings_and_pane_rows_read_on_the_frosted_sidebar(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    cx.update(|cx| cx.set_global(InkProbes::default()));
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    let mut failures = Vec::new();
    for (name, appearance) in catalog() {
        let theme = appearance.native();
        view.update(cx, |view, _| {
            view.browser_state.appearance = Some(appearance)
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let (label, muted) = row_ink(&theme);
        let plates = plates(&theme, true);
        let probes = cx.update(|_, cx| cx.global::<InkProbes>().0.clone());
        // Row 0 is the open session's heading, row 1 its pane.
        for (key, ink) in [("sidebar-label-0", muted), ("sidebar-label-1", label)] {
            let ink: Hsla = rgb(ink).into();
            let painted = probes.get(key).copied();
            if painted != Some(ink) {
                failures.push(format!("{name}: {key} painted {painted:?}, not {ink:?}"));
                continue;
            }
            let ratio = worst(ink, &plates);
            if ratio < 4.5 {
                failures.push(format!("{name}: {key} is {ratio:.2}:1"));
            }
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

/// A heading is a Subheadline line and a pane row a Callout line on a 20pt
/// kind tile, so the open project reads as a group of panes.
#[gpui::test]
fn headings_and_pane_rows_sit_on_the_ladder(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (_, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let heading = cx.debug_bounds("tmux-sidebar-label-0").unwrap();
    let pane = cx.debug_bounds("tmux-sidebar-label-1").unwrap();
    let row = cx.debug_bounds("tmux-sidebar-pane:pane-a").unwrap();
    use bezel_theme::TextStyle;
    assert!(heading.size.height < pane.size.height);
    assert!(TextStyle::Subheadline.size() < TextStyle::Callout.size());
    // The tile and the row's padding: 20pt plus 5pt above and below.
    assert!(row.size.height >= px(30.), "{row:?}");
    assert!(heading.bottom() <= row.top());
}

/// Each state's glyph reads at the contrast setting's mark ratio on the
/// frosted sidebar, bare and under the row's washes, in every catalog variant:
/// with the pill's words gone, the glyph is the only sign of the state (#746).
/// The same marks in a pane header read on its plates.
#[gpui::test]
fn state_glyphs_read_on_the_frosted_sidebar(cx: &mut TestAppContext) {
    use crate::contrast::Contrast;
    use crate::tmux_snapshot::agent_indicator::{Plate, color};
    use crate::tmux_snapshot::pane_chrome::header_plates;
    let states = [
        ("WORKING", true),
        ("DONE", true),
        ("FAILED", true),
        ("DISCONNECTED", true),
        ("IDLE", false),
    ];
    let json = |status: &str, available: bool| {
        serde_json::json!({"key":"agent","sessionId":"session-a",
            "paneId":"pane-a","name":"Claude","sessionLabel":"x","harness":"claude-code",
            "status":status,"attention":false,"available":available})
    };
    let (sender, _receiver) = mpsc::sync_channel(64);
    cx.update(|cx| cx.set_global(InkProbes::default()));
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.simulate_resize(size(px(640.), px(400.)));
    let (mut failures, mut raw_misses) = (Vec::new(), 0);
    for (name, appearance) in catalog() {
        let plates = plates(&appearance.native(), true);
        for (status, available) in states {
            // What the sidebar paints, at the app's Standard contrast.
            view.update(cx, |view, _| {
                view.browser_state.appearance = Some(appearance.clone());
                view.browser_state.workspace_agents = Some(
                    serde_json::from_value(serde_json::json!({"sessionId":"session-a",
                        "revision":1,"phase":"live","rows":[json(status, available)],"observedSessions":1,"totalSessions":1,
                        "truncatedSessions":0,"truncatedRows":0,"note":null}))
                    .unwrap(),
                );
            });
            cx.update(|_, cx| cx.global_mut::<InkProbes>().0.clear());
            cx.update(|window, cx| window.draw(cx).clear(cx));
            let row: browser::home_agents::Row =
                serde_json::from_value(json(status, available)).unwrap();
            let theme = appearance.native();
            // The sidebar row paints the sidebar's ink (the header's call
            // site is checked in pane_chrome_tests/ink.rs).
            let painted = cx.update(|_, cx| {
                cx.global::<InkProbes>()
                    .0
                    .get("agent-glyph-Sidebar")
                    .copied()
            });
            let expected: Hsla = rgb(color(&row, !available, &theme, Plate::Sidebar)).into();
            if painted != Some(expected) {
                failures.push(format!("{name} {status}: painted {painted:?}"));
            }
            for contrast in [Contrast::Standard, Contrast::High] {
                let mut theme = appearance.native();
                theme.contrast = contrast;
                let target = contrast.mark_ratio();
                let raw: Hsla = rgb(theme.muted).into();
                raw_misses += usize::from(worst(raw, &plates) < target);
                let ink: Hsla = rgb(color(&row, !available, &theme, Plate::Sidebar)).into();
                let ratio = worst(ink, &plates);
                if ratio < target {
                    failures.push(format!("{name} {status} {contrast:?}: {ratio:.2}:1"));
                }
                let header = color(&row, !available, &theme, Plate::Header);
                for plate in header_plates(&theme) {
                    let ratio = crate::contrast::ratio(header, plate);
                    if ratio < target - 0.01 {
                        failures.push(format!("{name} {status} {contrast:?} header: {ratio:.2}:1"));
                    }
                }
            }
        }
    }
    assert!(
        raw_misses > 0,
        "raw muted must miss somewhere, or this proves little"
    );
    assert!(
        failures.is_empty(),
        "{} failures: {failures:#?}",
        failures.len()
    );
}
