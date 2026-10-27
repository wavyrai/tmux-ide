use super::*;

#[gpui::test]
fn home_columns_share_wide_row_and_stack_in_narrow_window(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (_, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    for (width, wide) in [(1400., true), (800., false)] {
        cx.simulate_resize(size(px(width), px(1000.)));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let fleet = cx.debug_bounds("home-fleet-column").unwrap();
        let agents = cx.debug_bounds("home-agents-column").unwrap();
        let home = cx.debug_bounds("tmux-home").unwrap();
        assert!(fleet.left() >= home.left() && agents.right() <= home.right());
        if wide {
            assert!(agents.left() > fleet.right());
            assert_eq!(agents.top(), fleet.top());
        } else {
            assert!(agents.top() > fleet.bottom());
            assert_eq!(agents.left(), fleet.left());
        }
        assert!(cx.debug_bounds("home-new-local-session").is_some());
    }
    assert!(receiver.try_recv().is_err());
}
