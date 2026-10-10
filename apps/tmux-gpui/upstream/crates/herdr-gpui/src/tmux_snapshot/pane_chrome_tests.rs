use super::*;
use crate::tmux_snapshot::browser::Choice;
use core::prelude::v1::test;
#[test]
fn title_uses_selected_identity_and_keeps_readiness_independent() {
    let mut state = State {
        selected_pane: Some("b".into()),
        status: "Waiting for input authority".into(),
        panes: vec![
            Choice {
                id: "a".into(),
                label: "Other".into(),
                pane_count: None,
                window_id: None,
                window_label: None,
            },
            Choice {
                id: "b".into(),
                label: "Selected pane".into(),
                pane_count: None,
                window_id: None,
                window_label: None,
            },
        ],
        ..Default::default()
    };
    assert_eq!(
        selected_title(&state),
        Some("Selected: Selected pane".into())
    );
    assert!(!state.input_ready);
    assert_eq!(state.status, "Waiting for input authority");
    state.selected_pane = Some("Selected pane".into());
    assert_eq!(selected_title(&state), None);
}
#[test]
fn display_label_is_bounded_unicode_safe_and_control_free() {
    let state = State {
        selected_pane: Some("a".into()),
        panes: vec![Choice {
            id: "a".into(),
            label: format!("\n{}\0", "界".repeat(200)),
            pane_count: None,
            window_id: None,
            window_label: None,
        }],
        ..Default::default()
    };
    assert_eq!(
        selected_title(&state),
        Some(format!("Selected: {}", "界".repeat(96)))
    );
}

fn header_state(rects: &[(&str, u16, u16, u16, u16)]) -> State {
    let frame = herdr_client::protocol::FrameData {
        width: 20,
        height: 12,
        cells: vec![
            herdr_client::protocol::CellData {
                symbol: " ".into(),
                fg: 0,
                bg: 0,
                modifier: 0,
                skip: false,
                hyperlink: None
            };
            240
        ],
        cursor: None,
        hyperlinks: vec![],
        graphics: vec![],
    };
    State {
        surface: crate::tmux_snapshot::browser::Surface::Workspace,
        frame: Some(Arc::new(frame)),
        panes: rects
            .iter()
            .map(|r| Choice {
                id: r.0.into(),
                label: format!("{}{}", r.0, "界".repeat(200)),
                pane_count: None,
                window_id: None,
                window_label: None,
            })
            .collect(),
        regions: rects
            .iter()
            .map(|r| hit_regions::Region {
                id: r.0.into(),
                left: r.1,
                top: r.2,
                width: r.3,
                height: r.4,
            })
            .collect(),
        ..Default::default()
    }
}
fn assert_no_overlap(state: &State) {
    for h in headers(state) {
        assert!(h.width > 0);
        assert!(h.left + h.width <= 20);
        if let Some(row) = h.row {
            for col in h.left..h.left + h.width {
                assert!(!state.regions.iter().any(|r| col >= r.left
                    && col < r.left + r.width
                    && row >= r.top
                    && row < r.top + r.height));
            }
        }
    }
}
#[test]
fn full_headers_cover_vertical_horizontal_nested_and_zoom_geometry() {
    for rects in [
        vec![("a", 0, 0, 9, 12), ("b", 10, 0, 10, 12)],
        vec![("a", 0, 0, 20, 5), ("b", 0, 6, 20, 6)],
        vec![("a", 0, 0, 9, 12), ("b", 10, 0, 10, 5), ("c", 10, 6, 10, 6)],
        vec![("zoom", 0, 0, 20, 12)],
    ] {
        let state = header_state(&rects);
        assert_eq!(headers(&state).len(), rects.len());
        assert_no_overlap(&state);
        for h in headers(&state) {
            assert_eq!(label(&state, &h.id).chars().count(), 96);
        }
    }
}
#[test]
fn lower_headers_compact_around_occupied_cells_and_reject_visible_gap_data() -> Result<()> {
    let mut state = header_state(&[("a", 0, 0, 9, 12), ("b", 10, 0, 10, 5), ("c", 10, 6, 10, 6)]);
    let frame = Arc::make_mut(
        state
            .frame
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("fixture frame missing"))?,
    );
    frame.cells[5 * 20 + 10].symbol = "X".into();
    let lower = headers(&state)
        .into_iter()
        .find(|h| h.id == "c")
        .ok_or_else(|| anyhow::anyhow!("lower header missing"))?;
    assert_eq!((lower.left, lower.width, lower.row), (11, 9, Some(5)));
    assert_no_overlap(&state);
    let frame = Arc::make_mut(
        state
            .frame
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("fixture frame missing"))?,
    );
    for col in 10..20 {
        frame.cells[5 * 20 + col].symbol = "X".into();
    }
    assert!(!headers(&state).iter().any(|h| h.id == "c"));
    Ok(())
}
#[test]
fn headers_refuse_invalid_overlap_and_absent_frame() {
    let mut state = header_state(&[("a", 0, 0, 20, 8), ("b", 0, 6, 20, 6)]);
    assert!(headers(&state).is_empty());
    state.frame = None;
    assert!(headers(&state).is_empty());
}
#[test]
fn header_callback_publication_fence_rejects_replaced_frame_request_and_regions() -> Result<()> {
    let state = header_state(&[("a", 0, 0, 9, 12), ("b", 10, 0, 10, 12)]);
    let frame = state
        .frame
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("fixture frame missing"))?;
    assert!(publication_current(&state, 0, frame, &state.regions, "b"));
    assert!(!publication_current(&state, 1, frame, &state.regions, "b"));
    assert!(!publication_current(
        &state,
        0,
        frame,
        &state.regions,
        "missing"
    ));
    let mut changed = state.clone();
    changed.regions[1].width = 9;
    assert!(!publication_current(
        &changed,
        0,
        frame,
        &state.regions,
        "b"
    ));
    changed = state.clone();
    changed.frame = Some(Arc::new((**frame).clone()));
    assert!(!publication_current(
        &changed,
        0,
        frame,
        &state.regions,
        "b"
    ));
    Ok(())
}
