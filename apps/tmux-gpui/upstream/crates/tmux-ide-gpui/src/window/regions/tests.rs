#![allow(clippy::unwrap_used)]

use super::{HerdrWindow, Owner, partition};
use crate::sidebar::layout_tests::fixture_window;
use crate::terminal_painter::Layer;
use gpui::{Entity, EntityId, TestAppContext, VisualTestContext};
use herdr_client::protocol::{
    CellData, CursorState, FrameData, PaneSurfaceFrame, PaneSurfacePane, SurfaceRect,
};
use std::sync::Arc;

fn rect(x: u16, y: u16, width: u16, height: u16) -> SurfaceRect {
    SurfaceRect {
        x,
        y,
        width,
        height,
    }
}

fn pane(id: &str, rect: SurfaceRect) -> PaneSurfacePane {
    PaneSurfacePane {
        pane_id: id.into(),
        content_revision: 1,
        rect,
        inner_rect: rect,
        scrollbar_rect: None,
        scroll: None,
        focused: false,
        mouse_reporting: false,
        sgr_pixel_mouse: false,
        alternate_screen_active: false,
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn frame(rows: &[&str]) -> FrameData {
    let width = rows[0].chars().count() as u16;
    FrameData {
        width,
        height: rows.len() as u16,
        cells: rows
            .iter()
            .flat_map(|row| row.chars())
            .map(|symbol| CellData {
                symbol: symbol.to_string(),
                fg: 0,
                bg: 0,
                modifier: 0,
                skip: false,
                hyperlink: None,
            })
            .collect(),
        cursor: None,
        hyperlinks: vec![],
        graphics: vec![],
    }
}

/// Each cell's owner, row by row, as the partition assigns it.
fn owners(frame: &FrameData, panes: &[PaneSurfacePane]) -> Vec<Vec<Option<Owner>>> {
    let mut grid = vec![vec![None; usize::from(frame.width)]; usize::from(frame.height)];
    for (owner, area) in partition(frame, panes) {
        for span in area {
            for x in span.columns {
                let cell = &mut grid[usize::from(span.row)][usize::from(x)];
                assert!(cell.is_none(), "cell {x},{} painted twice", span.row);
                *cell = Some(owner.clone());
            }
        }
    }
    grid
}

#[test]
fn every_cell_belongs_to_one_region_and_earlier_panes_win_overlaps() {
    let frame = frame(&["aaaa|bbbb", "aaaa|bbbb", "---------"]);
    let a = Owner::Pane("a".into());
    let b = Owner::Pane("b".into());
    // Side by side, with a border column and a status row between them.
    let grid = owners(
        &frame,
        &[pane("a", rect(0, 0, 4, 2)), pane("b", rect(5, 0, 4, 2))],
    );
    for row in &grid[..2] {
        assert!(row[..4].iter().all(|o| o.as_ref() == Some(&a)));
        assert_eq!(row[4], Some(Owner::Chrome));
        assert!(row[5..].iter().all(|o| o.as_ref() == Some(&b)));
    }
    assert!(grid[2].iter().all(|o| o.as_ref() == Some(&Owner::Chrome)));
    // A pane over another, and one reaching past the grid, still paint
    // each cell once: the first listed keeps the shared cells.
    let grid = owners(
        &frame,
        &[pane("a", rect(2, 1, 4, 5)), pane("b", rect(0, 0, 20, 2))],
    );
    assert_eq!(grid[0], vec![Some(b.clone()); 9]);
    assert_eq!(
        grid[1],
        [&b, &b, &a, &a, &a, &a, &b, &b, &b].map(|o| Some(o.clone()))
    );
    assert!(grid[2][2..6].iter().all(|o| o.as_ref() == Some(&a)));
    assert!(
        grid[2][..2]
            .iter()
            .all(|o| o.as_ref() == Some(&Owner::Chrome))
    );
}

/// Draws `surface` and returns each region's layer views in owner order.
fn draw(
    view: &Entity<HerdrWindow>,
    surface: &PaneSurfaceFrame,
    cx: &mut VisualTestContext,
) -> Vec<(Owner, [EntityId; 3])> {
    view.update(cx, |view, _| {
        let snapshot = view.live.snapshot.as_ref().unwrap();
        let mut surface = surface.clone();
        surface.boot_id = snapshot.boot_id.clone();
        surface.projection_revision = snapshot.revision;
        view.live.surface = Some(Arc::new(surface));
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    view.read_with(cx, |view, cx| {
        view.regions
            .iter()
            .map(|views| {
                let owner = views[0].read(cx).region.owner.clone();
                for (view, layer) in views.iter().zip(Layer::ALL) {
                    let view = view.read(cx);
                    assert_eq!((&view.region.owner, view.layer), (&owner, layer));
                }
                (owner, views.each_ref().map(Entity::entity_id))
            })
            .collect()
    })
}

#[gpui::test]
fn only_regions_whose_paint_changed_are_replaced(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    let mut surface = PaneSurfaceFrame {
        boot_id: String::new(),
        projection_revision: 0,
        surface_revision: 1,
        frame: frame(&["aaaa|bbbb", "aaaa|bbbb"]),
        panes: vec![pane("a", rect(0, 0, 4, 2)), pane("b", rect(5, 0, 4, 2))],
        splits: vec![],
        popup: None,
        graphics: Default::default(),
    };
    let first = draw(&view, &surface, cx);
    let owners: Vec<_> = first.iter().map(|(owner, _)| owner.clone()).collect();
    assert_eq!(
        owners,
        [
            Owner::Pane("a".into()),
            Owner::Pane("b".into()),
            Owner::Chrome
        ]
    );
    // The same cells in a new frame repaint nothing.
    assert_eq!(draw(&view, &surface, cx), first);
    // Output in one pane replaces only that pane's region.
    surface.frame.cells[6].symbol = "x".into();
    let second = draw(&view, &surface, cx);
    assert_eq!(second[0], first[0]);
    assert_ne!(second[1], first[1]);
    assert_eq!(second[2], first[2]);
    // The cursor leaving one pane for another changes both.
    surface.frame.cursor = Some(CursorState {
        x: 1,
        y: 1,
        visible: true,
        shape: 0,
    });
    let third = draw(&view, &surface, cx);
    assert_ne!(third[0], second[0]);
    assert_eq!(third[1..], second[1..]);
    surface.frame.cursor.as_mut().unwrap().x = 6;
    let fourth = draw(&view, &surface, cx);
    assert_ne!(fourth[0], third[0]);
    assert_ne!(fourth[1], third[1]);
    assert_eq!(fourth[2], third[2]);
}
