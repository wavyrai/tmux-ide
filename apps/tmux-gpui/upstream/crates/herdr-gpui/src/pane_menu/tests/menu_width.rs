use super::*;

/// The rows' and labels' debug selectors, in menu order.
const ROWS: [&str; 9] = [
    "pane-menu-0",
    "pane-menu-1",
    "pane-menu-2",
    "pane-menu-3",
    "pane-menu-4",
    "pane-menu-5",
    "pane-menu-6",
    "pane-menu-7",
    "pane-menu-8",
];
const LABELS: [&str; 9] = [
    "pane-menu-label-0",
    "pane-menu-label-1",
    "pane-menu-label-2",
    "pane-menu-label-3",
    "pane-menu-label-4",
    "pane-menu-label-5",
    "pane-menu-label-6",
    "pane-menu-label-7",
    "pane-menu-label-8",
];

/// Opens the pane menu on "inactive" in a window `width` wide. Another pane
/// has focus, so the swap row shows; `routed` picks the longer right-click
/// label.
fn open_menu(
    routed: bool,
    width: f32,
    cx: &mut TestAppContext,
) -> (Entity<HerdrWindow>, &mut VisualTestContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = crate::sidebar::layout_tests::fixture_window(window, cx);
        let mut snapshot = snapshot();
        snapshot.panes[1].right_click_passthrough = routed;
        view.live.snapshot = Some(Arc::new(snapshot));
        view
    });
    cx.simulate_resize(size(px(width), px(600.)));
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.open_pane_menu("inactive", point(px(20.), px(20.)), window, cx)
        });
        window.draw(cx).clear(cx);
    });
    (view, cx)
}

fn labels(view: &Entity<HerdrWindow>, cx: &mut VisualTestContext) -> Vec<&'static str> {
    view.read_with(cx, |v, _| {
        let pane = v.menu.pane.as_ref().unwrap();
        pane.actions()
            .into_iter()
            .map(|action| action.label(&pane.target))
            .collect()
    })
}

#[gpui::test]
fn pane_menu_shows_every_label_in_full(cx: &mut TestAppContext) {
    for (routed, longest) in [
        (false, "Send Right-Clicks to Pane"),
        (true, "Open This Menu on Right-Click"),
    ] {
        let (view, cx) = open_menu(routed, 800., cx);
        let labels = labels(&view, cx);
        assert!(labels.contains(&"Swap with Focused Pane"));
        assert!(labels.contains(&longest));
        let font_size = view.read_with(cx, |v, _| px(v.config.ui.size));
        let panel = cx.debug_bounds("menu-panel").unwrap();
        for (index, label) in labels.into_iter().enumerate() {
            let row = cx.debug_bounds(ROWS[index]).unwrap();
            let text = cx.debug_bounds(LABELS[index]).unwrap();
            let natural = cx.update(|window, _| {
                window
                    .text_system()
                    .shape_line(
                        label.into(),
                        font_size,
                        &[window.text_style().to_run(label.len())],
                        None,
                    )
                    .width
            });
            assert!(
                text.size.width >= natural - px(0.5),
                "{label:?} needs {natural:?} but has {:?}",
                text.size.width
            );
            assert!(
                text.right() <= row.right() && row.right() <= panel.right(),
                "{label:?} ends at {:?}, past its row {row:?} or panel {panel:?}",
                text.right()
            );
        }
    }
}

#[gpui::test]
fn pane_menu_stays_inside_a_narrow_window(cx: &mut TestAppContext) {
    let width = 160.;
    let (view, cx) = open_menu(true, width, cx);
    let count = labels(&view, cx).len();
    let panel = cx.debug_bounds("menu-panel").unwrap();
    assert!(
        panel.left() >= px(0.) && panel.right() <= px(width),
        "{panel:?}"
    );
    for selector in &LABELS[..count] {
        let text = cx.debug_bounds(selector).unwrap();
        assert!(text.right() <= panel.right(), "{selector}: {text:?}");
    }
}

#[gpui::test]
fn pane_menu_error_wraps_inside_the_labels_width(cx: &mut TestAppContext) {
    let (view, cx) = open_menu(false, 800., cx);
    let before = cx.debug_bounds("menu-panel").unwrap();
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.pane_error(
                "the daemon refused this request for a reason that takes many words to explain",
                cx,
            )
        });
        window.draw(cx).clear(cx);
    });
    let after = cx.debug_bounds("menu-panel").unwrap();
    assert_eq!(after.size.width, before.size.width);
    assert!(after.size.height > before.size.height);
}
