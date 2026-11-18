//! A reader pane reflows on every frame of a window resize, as its card
//! does: it follows the card's painted edge, not the cell grid that tmux
//! has not answered yet.
#![allow(clippy::unwrap_used)]
use super::reader_keys_tests::setup;
use super::*;
use crate::tmux_snapshot::reader::Status;
use std::sync::mpsc;

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| window.draw(cx).clear(cx));
}

#[gpui::test]
fn a_reader_follows_the_window_on_every_frame_of_a_resize(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        crate::tmux_snapshot::fit_test_support::fixture_view(
            window,
            cx,
            sender,
            7,
            browser::State {
                surface: browser::Surface::Workspace,
                ..Default::default()
            },
        )
    });
    cx.update(|window, cx| view.update(cx, |view, cx| setup(view, window, cx, Status::Ready)));
    cx.simulate_resize(size(px(900.), px(700.)));
    draw(cx);
    draw(cx);
    let before = cx.debug_bounds("reader:pane-a").unwrap();
    let card = |cx: &mut VisualTestContext| {
        view.read_with(cx, |v, _| {
            let (canvas, _) = v.input_geometry.unwrap();
            canvas
        })
    };
    let canvas = card(cx);
    // The reader reaches its card's right edge, inside the card's padding.
    assert_eq!(
        before.right(),
        canvas.right() - px(crate::tmux_snapshot::pane_cards::PAD),
        "{before:?} in {canvas:?}"
    );
    // Each frame of a drag, wider and then narrower, with no reply from tmux
    // (the regions stay as they were): the reader's width moves with the
    // window in that same frame.
    for width in [940., 1000., 1100., 1040., 960., 880.] {
        cx.simulate_resize(size(px(width), px(700.)));
        draw(cx);
        let reader = cx.debug_bounds("reader:pane-a").unwrap();
        let canvas = card(cx);
        assert_eq!(reader.origin, before.origin, "{width}");
        assert_eq!(
            reader.right(),
            canvas.right() - px(crate::tmux_snapshot::pane_cards::PAD),
            "{width}: the reader lags the window ({reader:?} in {canvas:?})"
        );
    }
    // And taller and shorter: the reader reaches the card's bottom edge.
    for height in [740., 800., 660., 600.] {
        cx.simulate_resize(size(px(880.), px(height)));
        draw(cx);
        let reader = cx.debug_bounds("reader:pane-a").unwrap();
        let canvas = card(cx);
        assert_eq!(
            reader.bottom(),
            canvas.bottom() - px(crate::tmux_snapshot::pane_cards::V_PAD),
            "{height}: the reader lags the window ({reader:?} in {canvas:?})"
        );
    }
}
