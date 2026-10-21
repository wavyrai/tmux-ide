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

#[test]
fn same_window_reselect_preserves_exact_fit_without_borrowing_stale_lifetimes() {
    assert_eq!(reselect_fit(Some((4, 111, 37)), 4, 5), Some((5, 111, 37)));
    assert_eq!(reselect_fit(Some((3, 111, 37)), 4, 5), None);
    assert_eq!(reselect_fit(None, 4, 5), None);
    // A real drawable resize still differs from the transferred fit.
    assert_ne!(reselect_fit(Some((4, 111, 37)), 4, 5), Some((5, 112, 37)));
}
