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
