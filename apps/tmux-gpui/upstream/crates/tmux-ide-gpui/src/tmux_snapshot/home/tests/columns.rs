use super::*;

#[gpui::test]
fn home_list_and_table_share_wide_row_and_stack_in_narrow_window(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (_, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.fleet = Some(
            serde_json::from_slice(include_bytes!(
                "../../../../../../../fixtures/home-fleet.json"
            ))
            .unwrap(),
        );
        view
    });
    receiver.try_iter().for_each(drop);
    for (width, wide) in [(1400., true), (800., false)] {
        cx.simulate_resize(size(px(width), px(1000.)));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let nav = cx.debug_bounds("home-fleet-nav").unwrap();
        let table = cx.debug_bounds("home-fleet-column").unwrap();
        let agents = cx.debug_bounds("home-agents-column").unwrap();
        let header = cx.debug_bounds("home-header").unwrap();
        assert!(nav.left() >= header.left() && table.right() <= header.right());
        if wide {
            assert!(table.left() > nav.right());
            assert_eq!(table.top(), nav.top());
        } else {
            // A wrapping row of the same entries over the table.
            assert!(table.top() > nav.bottom());
            assert_eq!(table.left(), nav.left());
            assert_eq!(table.right(), header.right());
            let all = cx.debug_bounds("home-nav-all").unwrap();
            let favourites = cx.debug_bounds("home-nav-favourites").unwrap();
            assert_eq!(all.top(), favourites.top());
        }
        // Agents sit under the table, in its column.
        assert_eq!(
            (agents.left(), agents.right()),
            (table.left(), table.right())
        );
        // The one primary action sits in the header line.
        let new = cx.debug_bounds("home-new-local-session").unwrap();
        assert!(new.top() >= header.top() && new.bottom() <= header.bottom());
    }
    assert!(receiver.try_recv().is_err());
}
