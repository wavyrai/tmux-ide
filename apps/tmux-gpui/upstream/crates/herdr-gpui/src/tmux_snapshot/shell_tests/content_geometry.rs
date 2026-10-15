use super::*;

#[gpui::test]
fn inset_content_keeps_headers_cells_and_resize_in_one_measured_rectangle(cx: &mut TestAppContext) {
    use super::super::super::{browser, geometry, keys};
    let (sender, receiver) = std::sync::mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|_, cx| browser_fixture(cx, sender));
    receiver.try_iter().for_each(drop);
    for (width, height, hidden) in [
        (640., 400., false),
        (1000., 700., false),
        (640., 400., true),
    ] {
        cx.update(|_, cx| {
            view.update(cx, |v, _| {
                v.sidebar_hidden = hidden;
                v.last_resize = None;
            })
        });
        cx.simulate_resize(size(px(width), px(height)));
        cx.update(|w, cx| w.draw(cx).clear(cx));
        let body = cx.debug_bounds("tmux-shell-body").unwrap();
        let inset = cx.debug_bounds("tmux-workspace-inset").unwrap();
        let content = cx.debug_bounds("tmux-workspace-content").unwrap();
        let windows = cx.debug_bounds("workspace-window-strip").unwrap();
        let panes = cx.debug_bounds("pane-header-row").unwrap();
        assert_eq!(
            content.left(),
            inset.left() + px(super::super::CONTENT_INSET)
        );
        assert_eq!(content.top(), inset.top() + px(super::super::CONTENT_INSET));
        assert_eq!(
            content.right(),
            body.right() - px(super::super::CONTENT_INSET)
        );
        assert_eq!(
            content.bottom(),
            body.bottom() - px(super::super::CONTENT_INSET)
        );
        if !hidden {
            let sidebar = cx.debug_bounds("tmux-sidebar-viewport").unwrap();
            assert_eq!(sidebar.size.width, px(224.));
            assert_eq!(sidebar.right(), inset.left());
            assert_eq!(sidebar.top(), body.top());
        } else {
            assert_eq!(inset.left(), body.left());
        }
        let expected = view.read_with(cx, |v, _| {
            let canvas = v.input_geometry.unwrap().0;
            assert_eq!(canvas.left(), windows.left());
            assert_eq!(canvas.right(), windows.right());
            assert_eq!(canvas.top(), panes.bottom());
            assert!(canvas.left() > content.left());
            assert!(windows.top() > content.top());
            assert!(canvas.bottom() < content.bottom());
            geometry::cell_grid(
                f32::from(canvas.size.width),
                f32::from(canvas.size.height),
                v.input_cell_width.unwrap(),
                v.terminal_height(),
            )
            .unwrap()
        });
        let mut last = None;
        for command in receiver.try_iter() {
            match command {
                browser::Command::Input {
                    input: keys::Input::Resize { cols, rows },
                    ..
                } => last = Some((cols, rows)),
                _ => panic!("layout must not change selection or send keys"),
            }
        }
        assert_eq!(last, Some(expected));
    }
    cx.update(|w, cx| {
        view.update(cx, |v, _| v.browser_state.surface = browser::Surface::Home);
        w.draw(cx).clear(cx);
    });
    let content = cx.debug_bounds("tmux-workspace-content").unwrap();
    let home = cx.debug_bounds("tmux-home").unwrap();
    assert!(home.left() > content.left() && home.right() < content.right());
    assert!(home.top() > content.top() && home.bottom() < content.bottom());
    assert!(receiver.try_recv().is_err());
}
