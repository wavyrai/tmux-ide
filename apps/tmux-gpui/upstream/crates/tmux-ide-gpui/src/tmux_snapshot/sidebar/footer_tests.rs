//! The sidebar footer on Bezel's control group.
use super::*;

/// The footer is a control group: it hugs its three buttons, inset by the
/// group's 2pt pad inside its 1pt hairline, and each still acts on a press.
#[gpui::test]
fn footer_group_holds_its_buttons_and_each_still_acts(cx: &mut TestAppContext) {
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
    let buttons: Vec<_> = ["open-picker", "open-theme-picker", "refresh-sessions"]
        .into_iter()
        .map(|selector| cx.debug_bounds(selector).unwrap())
        .collect();
    let inset = px(3.);
    assert_eq!(footer.left() - viewport.left(), px(8.));
    assert_eq!(buttons[0].left() - footer.left(), inset);
    assert_eq!(footer.right() - buttons[2].right(), inset);
    assert_eq!(buttons[1].left() - buttons[0].right(), px(2.));
    assert_eq!(buttons[2].left() - buttons[1].right(), px(2.));
    for button in &buttons {
        assert_eq!(button.top() - footer.top(), inset);
        assert_eq!(footer.bottom() - button.bottom(), inset);
    }
    cx.simulate_click(buttons[0].center(), Modifiers::default());
    view.read_with(cx, |view, _| assert!(view.picker.is_some(), "Switch opens"));
    cx.simulate_keystrokes("escape");
    view.read_with(cx, |view, _| assert!(view.picker.is_none()));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.simulate_click(buttons[1].center(), Modifiers::default());
    view.read_with(cx, |view, _| assert!(view.picker.is_some(), "Theme opens"));
    cx.simulate_keystrokes("escape");
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    cx.simulate_click(buttons[2].center(), Modifiers::default());
    let commands: Vec<_> = receiver.try_iter().collect();
    assert!(
        matches!(commands.as_slice(), [browser::Command::Refresh { .. }]),
        "Refresh sends one refresh"
    );
}
