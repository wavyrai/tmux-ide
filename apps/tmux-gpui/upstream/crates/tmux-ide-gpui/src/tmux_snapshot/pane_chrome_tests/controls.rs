use super::*;
#[test]
fn narrow_headers_reserve_only_controls_that_fit_and_never_overlap_pane_cells() -> Result<()> {
    for cols in 1..=40 {
        let mut state = header_state(&[("a", 0, 0, 20, 5), ("b", 0, 6, 20, 6)]);
        let mut header = headers(&state)
            .pop()
            .ok_or_else(|| anyhow::anyhow!("fixture header missing"))?;
        header.width = cols;
        assert_eq!(has_control(&header, 8.), cols >= 7);
        assert_eq!(has_mode(&header, 8.), cols >= 14);
        if has_control(&header, 8.) {
            assert!(f32::from(cols) * 8. >= OVERFLOW_WIDTH + 12.);
        }
        state.regions.clear();
        assert!(headers(&state).is_empty());
    }
    Ok(())
}
