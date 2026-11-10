//! The sidebar footer: two clear-glass capsules (#746 v3).
use super::*;

/// Sessions and machines on the left, theme and settings on the right, each
/// pair in a capsule at Bezel's control height, no "Switch" label, and each
/// button still acts on a press.
#[gpui::test]
fn footer_capsules_hold_their_buttons_and_each_still_acts(cx: &mut TestAppContext) {
    // The appearance bezel paints in is process-wide: hold it, so no test
    // running alongside changes it under this one.
    let _appearance = bezel_theme::lock_appearance();
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        let (_, appearance) = text_role_tests::catalog().remove(0);
        view.browser_state.appearance = Some(appearance);
        view
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    let footer = cx.debug_bounds("tmux-sidebar-footer").unwrap();
    let viewport = cx.debug_bounds("tmux-sidebar-viewport").unwrap();
    let left = cx.debug_bounds("tmux-sidebar-footer-left").unwrap();
    let right = cx.debug_bounds("tmux-sidebar-footer-right").unwrap();
    assert_eq!(footer.left() - viewport.left(), px(8.));
    assert_eq!(viewport.right() - footer.right(), px(8.));
    assert_eq!(left.left(), footer.left());
    assert_eq!(right.right(), footer.right());
    let height = px(bezel_theme::ControlSize::Regular.height() + 4.);
    for capsule in [left, right] {
        assert_eq!(capsule.size.height, height);
    }
    for (id, capsule) in [
        ("open-picker", left),
        ("open-machines", left),
        ("open-theme-picker", right),
        ("open-commands", right),
    ] {
        let b = cx.debug_bounds(id).unwrap();
        assert!(capsule.contains(&b.center()), "{id}");
        assert_eq!(
            b.size.height,
            px(bezel_theme::ControlSize::Regular.height())
        );
    }
    // No "Switch" label: the sessions button is a square icon button.
    let sessions = cx.debug_bounds("open-picker").unwrap();
    assert_eq!(sessions.size.width, sessions.size.height);
    for id in [
        "open-picker",
        "open-machines",
        "open-theme-picker",
        "open-commands",
    ] {
        let center = cx.debug_bounds(id).unwrap().center();
        cx.simulate_click(center, Modifiers::default());
        view.read_with(cx, |view, _| assert!(view.picker.is_some(), "{id} opens"));
        cx.simulate_keystrokes("escape");
        cx.update(|window, cx| window.draw(cx).clear(cx));
        view.read_with(cx, |view, _| assert!(view.picker.is_none(), "{id} closes"));
    }
    // Opening a picker never refreshes or navigates.
    assert!(!receiver.try_iter().any(|c| matches!(
        c,
        browser::Command::Refresh { .. } | browser::Command::Session { .. }
    )));
}
