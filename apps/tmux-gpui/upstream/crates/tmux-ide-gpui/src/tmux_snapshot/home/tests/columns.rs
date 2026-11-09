use super::*;

#[gpui::test]
fn the_filter_row_sits_over_the_table_at_every_width(cx: &mut TestAppContext) {
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
    for width in [1400., 800.] {
        cx.simulate_resize(size(px(width), px(1000.)));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let nav = cx.debug_bounds("home-fleet-nav").unwrap();
        let table = cx.debug_bounds("home-fleet-column").unwrap();
        let agents = cx.debug_bounds("home-agents-column").unwrap();
        let header = cx.debug_bounds("home-header").unwrap();
        assert!(nav.left() >= header.left() && table.right() <= header.right());
        // One row of filters over the table (#746).
        assert!(table.top() > nav.bottom(), "{width}");
        assert_eq!(table.left(), nav.left());
        let all = cx.debug_bounds("home-nav-all").unwrap();
        let favourites = cx.debug_bounds("home-nav-favourites").unwrap();
        assert_eq!(all.top(), favourites.top());
        assert!(all.right() <= favourites.left());
        // Agents sit under the table, in its column.
        assert_eq!(
            (agents.left(), agents.right()),
            (table.left(), table.right())
        );
        // The title and the one primary action sit in the header line.
        let title = cx.debug_bounds("home-title").unwrap();
        let new = cx.debug_bounds("home-new-local-session").unwrap();
        assert!(title.left() <= nav.left() + px(1.));
        assert!(new.top() >= header.top() && new.bottom() <= header.bottom());
    }
    assert!(receiver.try_recv().is_err());
}

/// Home shows the sidebar with its Home row selected when the window leaves
/// the table room, and hides it in a narrow window (#746).
#[gpui::test]
fn home_keeps_the_sidebar_beside_a_wide_table(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (_, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.simulate_resize(size(px(1200.), px(800.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let sidebar = cx.debug_bounds("tmux-sidebar-viewport").unwrap();
    let home = cx.debug_bounds("tmux-sidebar-home").unwrap();
    let page = cx.debug_bounds("tmux-home").unwrap();
    assert!(home.left() >= sidebar.left() && home.right() <= sidebar.right());
    assert!(page.left() >= sidebar.right());
    cx.simulate_resize(size(px(800.), px(800.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert!(cx.debug_bounds("tmux-sidebar-viewport").is_none());
    assert!(receiver.try_recv().is_err());
}

/// New session wears the theme's one accent; its words read on it.
#[test]
fn text_on_the_accent_is_whichever_of_white_and_the_background_reads_better() {
    use crate::tmux_snapshot::new_session::on_accent;
    // Linen's clay takes white; Linen Dark's lighter clay its dark background.
    assert_eq!(on_accent(0x984822, 0xf7f4ee), 0xffffff);
    assert_eq!(on_accent(0xe0874f, 0x211f1b), 0x211f1b);
    for (accent, background) in [(0x984822, 0xf7f4ee), (0xe0874f, 0x211f1b)] {
        assert!(crate::contrast::ratio(on_accent(accent, background), accent) >= 4.5);
    }
}
