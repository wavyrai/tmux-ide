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
    let (expected, pixels, request, pane, already_fitted) = view.update(cx, |view, _| {
        let (cols, rows) = view.test_fitted_grid();
        let pixels = view.graphics.cell_pixels.get().unwrap();
        let request = view.browser_request;
        let pane = view.browser_state.selected_pane.clone().unwrap();
        let already_fitted = view.last_resize == Some((request, cols, rows));
        if !already_fitted {
            let fit = geometry::Fit {
                request,
                cols,
                rows,
                pixels,
            };
            assert!(
                view.fit_settle.ready(
                    fit,
                    view.last_resize,
                    false,
                    std::time::Instant::now() + std::time::Duration::from_millis(151),
                ),
                "renderer must already have scheduled this exact pending fit"
            );
            view.fit_settle.clear();
            assert!(!view.fit_settle.ready(
                fit,
                view.last_resize,
                false,
                std::time::Instant::now() - std::time::Duration::from_millis(151)
            ));
            assert!(view.fit_settle.due(std::time::Instant::now()));
        }
        ((cols, rows), pixels, request, pane, already_fitted)
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    if !already_fitted {
        let command = receiver.try_recv().unwrap();
        assert!(
            matches!(command, browser::Command::Input { input_target: None,
            request: owner, id, input: keys::Input::Resize { cols, rows, cell_width, cell_height, cell_width_milli, cell_height_milli }
        } if owner == request && id == pane && (cols, rows) == expected
            && (cell_width, cell_height, cell_width_milli, cell_height_milli)
                == (Some(pixels.0), Some(pixels.1), Some(pixels.2), Some(pixels.3))),
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
