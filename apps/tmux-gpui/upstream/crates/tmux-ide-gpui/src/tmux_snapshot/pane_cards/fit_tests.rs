#![allow(clippy::unwrap_used)]
//! #695: the grid sent to tmux is the grid the cards have room to paint.
use super::*;
use crate::tmux_snapshot::{browser, fit_test_support, keys};
use core::prelude::v1::test;
use gpui::{TestAppContext, VisualTestContext};
use herdr_client::protocol::{CellData, FrameData};
use std::sync::{Arc, mpsc};

fn region(id: &str, left: u16, top: u16, width: u16, height: u16) -> Region {
    Region {
        id: id.into(),
        left,
        top,
        width,
        height,
    }
}

fn frame(cols: u16, rows: u16) -> crate::tmux_snapshot::display_frame::DisplayFrame {
    Arc::new(FrameData {
        width: cols,
        height: rows,
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
                hyperlink: None
            };
            usize::from(cols) * usize::from(rows)
        ],
    })
    .into()
}

/// Two panes side by side, as tmux lays them out in `cols` columns: one
/// separator column between them.
fn side_by_side(cols: u16, rows: u16) -> Vec<Region> {
    let left = cols / 2;
    vec![
        region("pane-a", 0, 0, left, rows),
        region("pane-b", left + 1, 0, cols - left - 1, rows),
    ]
}

fn choice(id: &str) -> browser::Choice {
    browser::Choice {
        id: id.into(),
        label: id.into(),
        pane_count: None,
        window_id: Some("window".into()),
        browser_icon: None,
        display_name_source: None,
        window_label: None,
    }
}

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
    });
}

/// The last grid the view sent, with the command queue drained.
fn sent(receiver: &mpsc::Receiver<browser::Command>) -> Option<(u16, u16)> {
    receiver
        .try_iter()
        .filter_map(|command| match command {
            browser::Command::Input {
                input: keys::Input::Resize { cols, rows, .. },
                ..
            } => Some((cols, rows)),
            _ => None,
        })
        .last()
}

/// The owner's window (31 Oct capture, about 1560x1010) with two panes side
/// by side. The columns the app asks tmux for are exactly the columns the
/// two cards have room for at the font's advance: none clipped, none spare.
#[gpui::test]
fn the_grid_sent_for_two_panes_is_the_grid_the_cards_hold(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = fit_test_support::fixture_view(
            window,
            cx,
            sender,
            7,
            browser::State {
                request: 7,
                surface: browser::Surface::Workspace,
                input_ready: true,
                sessions: vec![choice("s1")],
                panes: vec![choice("pane-a"), choice("pane-b")],
                selected_session: Some("s1".into()),
                ..Default::default()
            },
        );
        view.browser_state.regions = side_by_side(132, 44);
        view.browser_state.frame = Some(frame(132, 44));
        view.frame = view.browser_state.frame.clone();
        view
    });
    cx.simulate_resize(size(px(1560.), px(1010.)));
    draw(cx);
    receiver.try_iter().for_each(drop);
    let mut grid = fit_test_support::settle(&view, cx, &receiver);
    // tmux answers with a window of that size; the app must then stay put.
    for _ in 0..3 {
        let (cols, rows) = grid;
        view.update(cx, |view, cx| {
            view.browser_state.regions = side_by_side(cols, rows);
            view.browser_state.frame = Some(frame(cols, rows));
            view.frame = view.browser_state.frame.clone();
            cx.notify();
        });
        draw(cx);
        draw(cx);
        cx.executor()
            .advance_clock(std::time::Duration::from_secs(1));
        draw(cx);
        match sent(&receiver) {
            Some(next) => grid = next,
            None => break,
        }
    }
    assert_eq!(sent(&receiver), None, "the fit settles");
    let (cols, rows) = grid;
    view.read_with(cx, |view, _| {
        let canvas = view.input_geometry.unwrap().0.size;
        let advance = view.input_cell_width.unwrap();
        let line = view.terminal_height();
        assert!(
            advance > 0. && canvas.width > px(600.),
            "{advance} {canvas:?}"
        );
        // Two cards: each pads its cells on both sides, and one gap between.
        let chrome = 4. * PAD + GAP;
        let cells = f32::from(cols - 1);
        let used = cells * advance + chrome;
        assert!(
            used <= f32::from(canvas.width),
            "{cols} columns need {used}pt of {canvas:?}"
        );
        assert!(
            used + advance > f32::from(canvas.width),
            "a spare column: {cols} columns use {used}pt of {canvas:?}"
        );
        let tall = f32::from(rows) * line + HEADER + 2. * V_PAD;
        assert!(tall <= f32::from(canvas.height) && tall + line > f32::from(canvas.height));
        let layout = view.card_layout(advance).unwrap();
        assert!(layout.regions == side_by_side(cols, rows));
        for r in &layout.regions {
            let content = layout.content(r);
            let card = layout.card_in(r, canvas);
            assert_eq!(content.size.width, px(f32::from(r.width) * advance));
            assert!(content.left() >= card.left() + px(PAD), "{}", r.id);
            assert!(content.right() + px(PAD) <= card.right(), "{}", r.id);
            assert!(card.right() <= canvas.width, "{} is clipped", r.id);
        }
    });
}

/// For any layout, canvas and advance (whole or fractional), the fitted grid
/// never puts a cell outside the canvas, and one more column would not fit.
#[test]
fn no_layout_fits_more_columns_than_its_cards_show() {
    for advance in [7., 7.8125, 8.4287, 9.6, 10., 12.03] {
        for canvas in [640., 1004., 1276.5, 1560., 2200.] {
            for cuts in 0..4u16 {
                // `cuts + 1` cards in a row, their widths found by the fit itself.
                let probe: Vec<_> = (0..=cuts)
                    .map(|i| region(&i.to_string(), i * 10, 0, 9, 20))
                    .collect();
                let overhead = Layout::new(&probe, advance, 20.).overhead();
                let Some((cols, _)) = crate::tmux_snapshot::geometry::cell_grid(
                    canvas - f32::from(overhead.width),
                    600.,
                    advance,
                    20.,
                ) else {
                    continue;
                };
                let each = (cols - cuts) / (cuts + 1);
                let regions: Vec<_> = (0..=cuts)
                    .map(|i| {
                        let left = i * (each + 1);
                        let width = if i == cuts { cols - left } else { each };
                        region(&i.to_string(), left, 0, width, 20)
                    })
                    .collect();
                let layout = Layout::new(&regions, advance, 20.);
                let last = layout.content(&regions[usize::from(cuts)]);
                let right = f32::from(last.right()) + PAD;
                assert!(
                    right <= canvas + 0.01,
                    "{cols} columns at {advance} in {canvas} with {cuts} cuts end at {right}"
                );
                assert!(
                    right + advance > canvas - 0.01,
                    "a spare column: {cols} at {advance} in {canvas} with {cuts} cuts"
                );
            }
        }
    }
}
