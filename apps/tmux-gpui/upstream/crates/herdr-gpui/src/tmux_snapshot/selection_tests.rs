use super::*;
fn state() -> anyhow::Result<browser::State> {
    let mut frame =
        super::super::decode::frame(include_bytes!("../../../../../fixtures/snapshot.json"))?;
    frame.cells[0].symbol = "A".into();
    frame.cells[1].symbol = "B".into();
    let region = copy::Region {
        id: "pane".into(),
        left: 0,
        top: 0,
        width: frame.width,
        height: frame.height,
        wrapped: vec![false; usize::from(frame.height)],
    };
    Ok(browser::State {
        frame: Some(Arc::new(frame)),
        copy_region: Some(region),
        selected_pane: Some("pane".into()),
        ..Default::default()
    })
}
#[test]
fn captured_text_and_highlight_survive_new_output() -> anyhow::Result<()> {
    let mut state = state()?;
    let mut selection =
        Capture::begin(&state, 0., 0.).ok_or_else(|| anyhow::anyhow!("selection"))?;
    selection.update(2., 0.)?;
    assert_eq!(selection.text()?, "AB");
    assert_eq!(selection.highlights[0].columns, 0..2);
    let mut next =
        super::super::decode::frame(include_bytes!("../../../../../fixtures/snapshot.json"))?;
    next.cells[0].symbol = "Z".into();
    state.frame = Some(Arc::new(next));
    assert!(selection.compatible(&state));
    assert_eq!(selection.text()?, "AB");
    state.frame = None;
    assert!(!selection.compatible(&state));
    Ok(())
}
#[test]
fn selection_rejects_new_target_or_geometry_and_clamps_drag() -> anyhow::Result<()> {
    let mut state = state()?;
    assert!(Capture::begin(&state, -1., 0.).is_none());
    assert!(Capture::begin(&state, f32::NAN, 0.).is_none());
    let mut selection =
        Capture::begin(&state, 0., 0.).ok_or_else(|| anyhow::anyhow!("selection"))?;
    assert!(selection.empty());
    selection.update(10000., 10000.)?;
    assert_eq!(selection.head, (19, 60));
    selection.update(0., -1.)?;
    assert!(selection.empty());
    state.selected_pane = Some("other".into());
    assert!(!selection.compatible(&state));
    state.selected_pane = Some("pane".into());
    if let Some(region) = &mut state.copy_region {
        region.left = 1;
    }
    assert!(!selection.compatible(&state));
    Ok(())
}
