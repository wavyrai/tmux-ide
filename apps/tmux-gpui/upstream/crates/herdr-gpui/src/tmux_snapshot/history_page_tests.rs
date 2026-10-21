//! Page keys use the selected terminal's painted content viewport, not the canvas.
use super::*;
use core::prelude::v1::test;
use herdr_client::protocol::{CellData, FrameData};

fn prepare(view: &mut SnapshotView, rows: u16) {
    let frame = Arc::new(FrameData {
        width: 20,
        height: 50,
        cursor: None,
        hyperlinks: vec![],
        graphics: vec![],
        cells: vec![
            CellData {
                symbol: " ".into(),
                fg: 0,
                bg: 0,
                modifier: 0,
                skip: false,
                hyperlink: None,
            };
            1000
        ],
    });
    view.frame = Some(frame.clone());
    view.browser_state.frame = Some(frame.clone());
    view.painted_frame = Some(frame);
    view.browser_state.request = view.browser_request;
    view.browser_state.history_offset = 30;
    view.browser_state.input_ready = false;
    view.input_interrupted = true;
    // Top status row and other panes belong to the composed canvas, not this page.
    view.browser_state.copy_region = Some(crate::tmux_snapshot::copy::Region {
        id: "pane-a".into(),
        left: 0,
        top: 1,
        width: 20,
        height: rows,
        wrapped: vec![false; usize::from(rows)],
    });
}

#[gpui::test]
fn history_page_keys_use_selected_content_height_without_rearming_input(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| view.update(cx, |view, cx| {
        for (rows, step) in [(20, 19), (1, 1)] {
            prepare(view, rows);
            for (key_name, expected) in [("shift-pageup", step), ("shift-pagedown", -step)] {
                view.terminal_key(&key(key_name), window, cx);
                assert!(matches!(receiver.try_recv(), Ok(browser::Command::Input { request: 7, id, input: Input::Scroll(lines) }) if id == "pane-a" && lines == expected));
                assert!(receiver.try_recv().is_err());
                assert!(view.input_interrupted);
                assert!(!view.browser_state.input_ready);
            }
        }
    }));
}

#[gpui::test]
fn history_page_keys_refuse_missing_stale_unpainted_or_invalid_geometry(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            for invalid in 0..6 {
                prepare(view, 20);
                match invalid {
                    0 => view.browser_state.copy_region = None,
                    1 => view.browser_state.selected_pane = Some("pane-b".into()),
                    2 => view.browser_state.request = view.browser_request - 1,
                    3 => view.painted_frame = None,
                    4 => {
                        if let Some(region) = &mut view.browser_state.copy_region {
                            region.height = 51;
                        }
                    }
                    _ => {
                        if let Some(region) = &mut view.browser_state.copy_region {
                            region.wrapped.clear();
                        }
                    }
                }
                view.terminal_key(&key("shift-pageup"), window, cx);
                view.terminal_key(&key("shift-pagedown"), window, cx);
                assert!(
                    receiver.try_recv().is_err(),
                    "invalid page geometry case {invalid}"
                );
                view.browser_state.selected_pane = Some("pane-a".into());
            }
            prepare(view, 20);
            view.browser_state.copy_region = None;
            view.painted_frame = None;
            view.terminal_key(&key("shift-end"), window, cx);
            assert!(matches!(
                receiver.try_recv(),
                Ok(browser::Command::Input {
                    input: Input::Scroll(0),
                    ..
                })
            ));
            assert!(receiver.try_recv().is_err());
            assert!(view.input_interrupted);
        })
    });
}
