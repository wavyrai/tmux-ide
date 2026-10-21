//! Finish fixture viewport changes before testing unrelated chrome commands.
#![allow(clippy::unwrap_used)]
use super::{SnapshotView, browser, geometry, keys};
use gpui::{Entity, VisualTestContext};
use std::sync::mpsc::Receiver;

pub(super) fn settle(
    view: &Entity<SnapshotView>,
    cx: &mut VisualTestContext,
    receiver: &Receiver<browser::Command>,
) -> (u16, u16) {
    assert!(
        receiver.try_recv().is_err(),
        "no command before viewport quiet interval"
    );
    let (expected, request, pane, already_fitted) = view.update(cx, |view, _| {
        let canvas = view.input_geometry.unwrap().0;
        let (cols, rows) = geometry::cell_grid(
            f32::from(canvas.size.width),
            f32::from(canvas.size.height),
            view.input_cell_width.unwrap(),
            view.terminal_height(),
        )
        .unwrap();
        let request = view.browser_request;
        let pane = view.browser_state.selected_pane.clone().unwrap();
        let already_fitted = view.last_resize == Some((request, cols, rows));
        if !already_fitted {
            let fit = geometry::Fit {
                request,
                cols,
                rows,
                pixels: view.graphics.cell_pixels.get().unwrap(),
            };
            view.fit_settle.clear();
            assert!(!view.fit_settle.ready(
                fit,
                view.last_resize,
                false,
                std::time::Instant::now() - std::time::Duration::from_millis(151)
            ));
            assert!(view.fit_settle.due(std::time::Instant::now()));
        }
        ((cols, rows), request, pane, already_fitted)
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    if !already_fitted {
        let command = receiver.try_recv().unwrap();
        assert!(
            matches!(command, browser::Command::Input {
            request: owner, id, input: keys::Input::Resize { cols, rows, .. }
        } if owner == request && id == pane && (cols, rows) == expected),
            "only exact current viewport geometry may settle"
        );
    }
    assert!(receiver.try_recv().is_err(), "only one settled command");
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert!(
        receiver.try_recv().is_err(),
        "settled geometry must not repeat"
    );
    expected
}
