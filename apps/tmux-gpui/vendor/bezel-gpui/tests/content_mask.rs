use gpui::{Bounds, ContentMask, Corners, point, px, size};

fn mask(x: f32, y: f32, w: f32, h: f32, radius: f32) -> ContentMask<gpui::Pixels> {
    ContentMask {
        bounds: Bounds::new(point(px(x), px(y)), size(px(w), px(h))),
        corner_radii: Corners::all(px(radius)),
    }
}

#[test]
fn flush_square_mask_keeps_the_outer_corners() {
    let outer = mask(0., 0., 100., 100., 10.);
    let inner = mask(0., 0., 100., 100., 0.);
    assert_eq!(outer.intersect(&inner).corner_radii, Corners::all(px(10.)));
    assert_eq!(inner.intersect(&outer).corner_radii, Corners::all(px(10.)));
}

#[test]
fn left_column_takes_only_the_corners_it_shares() {
    let outer = mask(0., 0., 100., 100., 10.);
    let column = mask(0., 0., 40., 100., 0.);
    let radii = outer.intersect(&column).corner_radii;
    assert_eq!(radii.top_left, px(10.));
    assert_eq!(radii.bottom_left, px(10.));
    assert_eq!(radii.top_right, px(0.));
    assert_eq!(radii.bottom_right, px(0.));
}

#[test]
fn inset_mask_keeps_its_own_corners() {
    let outer = mask(0., 0., 100., 100., 10.);
    let inner = mask(5., 5., 90., 90., 4.);
    assert_eq!(outer.intersect(&inner).corner_radii, Corners::all(px(4.)));
}
