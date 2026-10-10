use super::*;

#[test]
fn a_line_height_change_alone_remeasures_rows() {
    let previous = Config::default().terminal;
    assert!(!row_metrics_changed(&previous, &previous.clone()));

    // Family and size stay, so only the line height can invalidate the list.
    let mut font = previous.clone();
    font.line_height_multiple = Some(2.0);
    assert!(row_metrics_changed(&previous, &font));

    let mut font = previous.clone();
    font.size += 1.0;
    assert!(row_metrics_changed(&previous, &font));

    let mut font = previous.clone();
    font.family = "Line Height Test Mono".into();
    assert!(row_metrics_changed(&previous, &font));
}
