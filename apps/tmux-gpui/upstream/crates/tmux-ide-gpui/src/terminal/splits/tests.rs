use super::*;
use herdr_client::protocol::{ClientShellPopupSurface, FrameData, PaneSurfacePane, SurfaceRect};

fn rect(x: u16, y: u16, width: u16, height: u16) -> SurfaceRect {
    SurfaceRect {
        x,
        y,
        width,
        height,
    }
}

fn split(direction: PaneSurfaceSplitDirection, path: Vec<bool>) -> PaneSurfaceSplit {
    match direction {
        // Two panes side by side across 80 columns, the border at column 40.
        PaneSurfaceSplitDirection::Horizontal => PaneSurfaceSplit {
            direction,
            pos: 40,
            area: rect(0, 0, 80, 24),
            hit_rect: rect(40, 0, 1, 24),
            path,
        },
        // The right pane split top and bottom, the border at row 12.
        PaneSurfaceSplitDirection::Vertical => PaneSurfaceSplit {
            direction,
            pos: 12,
            area: rect(41, 0, 39, 24),
            hit_rect: rect(41, 12, 39, 1),
            path,
        },
    }
}

fn frame() -> FrameData {
    FrameData {
        cells: vec![],
        width: 80,
        height: 24,
        cursor: None,
        hyperlinks: vec![],
        graphics: vec![],
    }
}

fn pane(pane_id: &str) -> PaneSurfacePane {
    PaneSurfacePane {
        pane_id: pane_id.into(),
        content_revision: 1,
        rect: rect(0, 0, 40, 24),
        inner_rect: rect(0, 0, 40, 24),
        scrollbar_rect: None,
        scroll: None,
        focused: false,
        mouse_reporting: false,
        sgr_pixel_mouse: false,
        alternate_screen_active: false,
        pixel_width: 320,
        pixel_height: 480,
    }
}

fn surface(splits: Vec<PaneSurfaceSplit>) -> PaneSurfaceFrame {
    PaneSurfaceFrame {
        boot_id: "boot".into(),
        projection_revision: 1,
        surface_revision: 1,
        frame: frame(),
        panes: vec![pane("w1:p1"), pane("w1:p2")],
        splits,
        popup: None,
        graphics: Default::default(),
    }
}

#[test]
fn hit_testing_uses_cell_grid_and_ignores_popups_and_bad_geometry() {
    let side = split(PaneSurfaceSplitDirection::Horizontal, vec![]);
    let stack = split(PaneSurfaceSplitDirection::Vertical, vec![true]);
    let mut shell = surface(vec![side.clone(), stack.clone()]);
    assert_eq!(split_at(&shell, 40. * 8. + 7.9, 5., 8., 20.), Some(&side));
    assert_eq!(split_at(&shell, 40. * 8. - 0.1, 5., 8., 20.), None);
    assert_eq!(split_at(&shell, 41. * 8., 5., 8., 20.), None);
    assert_eq!(
        split_at(&shell, 50. * 8., 12. * 20. + 1., 8., 20.),
        Some(&stack)
    );
    assert_eq!(split_at(&shell, -1., 5., 8., 20.), None);
    assert_eq!(split_at(&shell, f32::NAN, 5., 8., 20.), None);
    assert_eq!(split_at(&shell, 320., 5., 0., 20.), None);
    assert_eq!(split_at(&shell, f32::MAX, 5., 8., 20.), None);

    shell.popup = Some(Box::new(ClientShellPopupSurface {
        terminal_id: "popup".into(),
        title: String::new(),
        width: None,
        height: None,
        frame: frame(),
        mouse_reporting: false,
        sgr_pixel_mouse: false,
        pixel_width: 640,
        pixel_height: 480,
    }));
    assert_eq!(split_at(&shell, 40. * 8., 5., 8., 20.), None);
}

#[test]
fn ratio_follows_the_axis_within_the_split_area_and_herdr_bounds() {
    let side = split(PaneSurfaceSplitDirection::Horizontal, vec![]);
    assert_eq!(along(side.direction, 3., 7.), 3.);
    assert_eq!(edge(&side, 8., 20.), 320.);
    assert_eq!(ratio(&side, 320., 8., 20.), Some(0.5));
    assert_eq!(ratio(&side, 160., 8., 20.), Some(0.25));
    assert_eq!(ratio(&side, 0., 8., 20.), Some(0.1));
    assert_eq!(ratio(&side, 10_000., 8., 20.), Some(0.9));
    assert_eq!(ratio(&side, 320., 0., 20.), None);
    assert_eq!(cursor(side.direction), CursorStyle::ResizeLeftRight);

    // A nested split measures from its own area, not the whole surface.
    let stack = split(PaneSurfaceSplitDirection::Vertical, vec![true]);
    assert_eq!(along(stack.direction, 3., 7.), 7.);
    assert_eq!(edge(&stack, 8., 20.), 240.);
    assert_eq!(ratio(&stack, 120., 8., 20.), Some(0.25));
    assert_eq!(cursor(stack.direction), CursorStyle::ResizeUpDown);

    let mut empty = side;
    empty.area.width = 0;
    assert_eq!(ratio(&empty, 320., 8., 20.), None);
}

#[test]
fn topology_ignores_border_positions_and_order_but_not_structure() {
    let side = split(PaneSurfaceSplitDirection::Horizontal, vec![]);
    let stack = split(PaneSurfaceSplitDirection::Vertical, vec![true]);
    let base = topology(&surface(vec![side.clone(), stack.clone()]));

    let mut moved = side.clone();
    moved.pos = 30;
    moved.hit_rect.x = 30;
    assert_eq!(topology(&surface(vec![stack.clone(), moved])), base);

    let mut turned = stack.clone();
    turned.direction = PaneSurfaceSplitDirection::Horizontal;
    assert_ne!(topology(&surface(vec![side.clone(), turned])), base);
    assert_ne!(topology(&surface(vec![side.clone()])), base);

    let mut other_panes = surface(vec![side, stack]);
    other_panes.panes[1].pane_id = "w1:p3".into();
    assert_ne!(topology(&other_panes), base);
}
