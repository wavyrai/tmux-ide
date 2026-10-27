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

#[test]
fn viewport_fit_is_first_immediate_then_latest_only_after_quiet() {
    use std::time::{Duration, Instant};
    let now = Instant::now();
    let initial = Fit {
        request: 1,
        cols: 111,
        rows: 37,
        pixels: (10, 20, 10000, 20000),
    };
    let mut owner = FitSettle::default();
    assert!(owner.ready(initial, None, true, now));
    let last = Some((1, 111, 37));
    for n in 1..=30 {
        assert!(!owner.ready(
            Fit {
                cols: 111 + n,
                ..initial
            },
            last,
            false,
            now + Duration::from_millis(u64::from(n) * 10)
        ));
    }
    assert!(!owner.due(now + Duration::from_millis(449)));
    assert!(
        owner.due(now + Duration::from_millis(450)),
        "browser tick wakes final fit without another paint"
    );
    assert!(owner.ready(
        Fit {
            cols: 141,
            ..initial
        },
        last,
        false,
        now + Duration::from_millis(450)
    ));
    owner.clear();
    assert!(!owner.due(now + Duration::from_secs(60)));
    assert!(!owner.ready(initial, last, false, now));
}

#[test]
fn fit_scope_pixels_cancellation_and_return_to_original_are_fenced() {
    use std::time::{Duration, Instant};
    let now = Instant::now();
    let fit = Fit {
        request: 1,
        cols: 80,
        rows: 24,
        pixels: (10, 20, 10000, 20000),
    };
    let last = Some((1, 80, 24));
    let mut owner = FitSettle::default();
    assert!(!owner.ready(Fit { cols: 90, ..fit }, last, false, now));
    assert!(!owner.ready(fit, last, false, now));
    assert!(
        !owner.due(now + Duration::from_secs(60)),
        "return to original cancels pending resize"
    );
    let new_pixels = Fit {
        pixels: (11, 20, 11000, 20000),
        ..fit
    };
    assert!(!owner.ready(new_pixels, last, true, now));
    assert!(owner.ready(new_pixels, last, true, now + Duration::from_millis(150)));
    owner.clear();
    assert!(
        owner.ready(Fit { request: 2, ..fit }, last, false, now),
        "new target first fit is immediate"
    );
    assert!(!owner.due(now + Duration::from_secs(60)));
}
