use super::*;
#[test]
fn floors_fractional_cells_and_ignores_minimized_or_invalid_bounds() {
    assert_eq!(cell_grid(809.99, 599.99, 10., 20.), Some((80, 29)));
    assert_eq!(cell_grid(810., 600., 10., 20.), Some((81, 30)));
    assert_eq!(cell_grid(810., 600., 12., 24.), Some((67, 25)));
    for (w, h, cw, ch) in [
        (0., 600., 10., 20.),
        (10., 10., 10., 20.),
        (f32::NAN, 600., 10., 20.),
        (800., 600., 0., 20.),
    ] {
        assert_eq!(cell_grid(w, h, cw, ch), None);
    }
}
