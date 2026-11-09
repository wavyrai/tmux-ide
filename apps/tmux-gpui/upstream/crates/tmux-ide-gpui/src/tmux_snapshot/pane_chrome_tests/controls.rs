use super::*;
#[test]
fn narrow_headers_drop_the_splits_first_and_never_overlap_pane_cells() -> Result<()> {
    for cols in 1..=60 {
        let mut state = header_state(&[("a", 0, 0, 20, 5), ("b", 0, 6, 20, 6)]);
        let mut header = headers(&state)
            .pop()
            .ok_or_else(|| anyhow::anyhow!("fixture header missing"))?;
        header.width = cols;
        let room = f32::from(cols) * 8.;
        let actions = action_width(&header, 8.);
        // Split right, split down, zoom, close; then zoom and close; then none.
        let expected = if room >= 240. {
            4. * SLOT
        } else if room >= 160. {
            2. * SLOT
        } else {
            0.
        };
        assert_eq!(actions, expected, "{cols} columns");
        assert!(actions <= room);
        for intent in BUTTONS {
            let shown = actions >= slot(intent) * SLOT;
            assert_eq!(
                shown,
                match intent {
                    HeaderIntent::SplitRight | HeaderIntent::SplitDown => room >= 240.,
                    _ => room >= 160.,
                },
                "{cols} columns"
            );
        }
        assert_eq!(
            has_mode(&header, 8.),
            cols >= 14 && room >= MODE_WIDTH + 12.
        );
        state.regions.clear();
        assert!(headers(&state).is_empty());
    }
    assert_eq!(
        action_width(
            &Header {
                id: "a".into(),
                left: 0,
                width: 40,
                row: None
            },
            f32::NAN
        ),
        0.
    );
    Ok(())
}
#[test]
fn the_buttons_run_split_right_split_down_zoom_close_from_left_to_right() {
    assert!(matches!(
        BUTTONS,
        [
            HeaderIntent::SplitRight,
            HeaderIntent::SplitDown,
            HeaderIntent::Expand,
            HeaderIntent::Close
        ]
    ));
    let slots: Vec<f32> = BUTTONS.iter().map(|&b| slot(b)).collect();
    assert_eq!(slots, [4., 3., 2., 1.]);
    assert_eq!(slot(HeaderIntent::Menu), 0.);
}
