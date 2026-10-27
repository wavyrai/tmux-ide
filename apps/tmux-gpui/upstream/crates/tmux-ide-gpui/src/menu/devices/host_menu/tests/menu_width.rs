use super::*;
use gpui::Entity;

const ROWS: [&str; 4] = ["host-menu-0", "host-menu-1", "host-menu-2", "host-menu-3"];
const LABELS: [&str; 4] = [
    "host-menu-label-0",
    "host-menu-label-1",
    "host-menu-label-2",
    "host-menu-label-3",
];

/// Opens the saved host's menu in a window `width` wide, with the device
/// named `name`.
fn open_menu<'a>(
    name: &str,
    width: f32,
    cx: &'a mut TestAppContext,
) -> (Entity<crate::HerdrWindow>, &'a mut VisualTestContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        add_host(&mut view);
        view
    });
    view.update(cx, |view, _| view.endpoints[1].label = name.into());
    cx.simulate_resize(size(px(width), px(600.)));
    view.update_in(cx, |view, window, cx| {
        view.open_host_menu(HOST, point(px(20.), px(20.)), window, cx)
    });
    cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
    (view, cx)
}

#[gpui::test]
fn host_menu_shows_every_label_in_full(cx: &mut TestAppContext) {
    // Saved SSH devices are unavailable on Windows, so there is no menu.
    if cfg!(windows) {
        return;
    }
    let (view, cx) = open_menu("m5max-ms", 800., cx);
    let font_size = view.read_with(cx, |v, _| px(v.config.ui.size));
    let panel = cx.debug_bounds("menu-panel").unwrap();
    for (index, (_, label)) in ACTIONS.into_iter().enumerate() {
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

/// A long device name ends with "…" in the header rather than widening the
/// menu past its actions.
#[gpui::test]
fn host_menu_header_does_not_widen_the_menu(cx: &mut TestAppContext) {
    if cfg!(windows) {
        return;
    }
    let short = {
        let (_, cx) = open_menu("m5max-ms", 800., cx);
        cx.debug_bounds("menu-panel").unwrap().size.width
    };
    let (_, cx) = open_menu(&"a-very-long-device-name-".repeat(4), 800., cx);
    let panel = cx.debug_bounds("menu-panel").unwrap();
    assert_eq!(panel.size.width, short);
    let header = cx.debug_bounds("host-menu-header").unwrap();
    assert!(header.right() <= panel.right(), "{header:?} {panel:?}");
}
