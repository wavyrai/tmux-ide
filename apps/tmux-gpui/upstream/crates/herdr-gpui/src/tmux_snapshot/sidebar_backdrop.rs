//! Opaque corner cutouts around sidebar glass, without covering its interior.
use gpui::{prelude::*, *};

pub(super) fn corners(color: u32) -> impl IntoElement {
    canvas(
        |_, _, _| (),
        move |bounds, (), window, _| {
            let radius = px(crate::config::corners::PANEL)
                .min(bounds.size.width / 2.)
                .min(bounds.size.height / 2.);
            if radius <= px(0.) {
                return;
            }
            // Same quarter-circle approximation as the terminal painter's round glyphs.
            let tangent = radius * (1. - 0.552_284_8);
            for (origin, dx, dy) in [
                (bounds.origin, 1., 1.),
                (point(bounds.right(), bounds.top()), -1., 1.),
                (point(bounds.right(), bounds.bottom()), -1., -1.),
                (point(bounds.left(), bounds.bottom()), 1., -1.),
            ] {
                let at = |x: Pixels, y: Pixels| point(origin.x + x * dx, origin.y + y * dy);
                let mut path = PathBuilder::fill();
                path.move_to(origin);
                path.line_to(at(radius, px(0.)));
                path.cubic_bezier_to(at(px(0.), radius), at(tangent, px(0.)), at(px(0.), tangent));
                path.close();
                if let Ok(path) = path.build() {
                    window.paint_path(path, rgb(color));
                }
            }
        },
    )
    .absolute()
    .size_full()
}
