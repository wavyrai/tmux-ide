use super::*;
#[test]
fn projection_uses_content_origin_and_rejects_replaced_or_clipped_regions() {
    let committed = Arc::new(pane());
    let snapshot = committed.snapshot.as_ref().unwrap();
    let mut region = crate::tmux_topology::Region {
        pane: "pane".into(),
        left: 7,
        top: 4,
        width: snapshot.cols,
        height: snapshot.rows + 1,
        content_top: 5,
        content_rows: snapshot.rows,
        source: Arc::clone(&committed),
    };
    let mut pool = Pool::default();
    let accepted = admit(&offer(), &committed, &mut pool).unwrap();
    assert_eq!(
        accepted.in_region(&region),
        Some(Placement {
            row: 5,
            column: 7,
            rows: 1,
            columns: 1
        })
    );
    region.content_rows = 0;
    assert!(accepted.in_region(&region).is_none());
    region.content_rows = snapshot.rows;
    region.source = Arc::new(pane());
    assert!(accepted.in_region(&region).is_none());
    region.source = Arc::clone(&committed);
    region.pane = "other".into();
    assert!(accepted.in_region(&region).is_none());
}

#[test]
fn placement_is_bounded_by_the_exact_committed_visible_grid_before_reservation() {
    let committed = pane();
    let snapshot = committed.snapshot.as_ref().unwrap();
    let mut pool = Pool::default();
    for rect in [
        json!({"row":0,"column":0,"rows":0,"columns":1}),
        json!({"row":snapshot.rows,"column":0,"rows":1,"columns":1}),
        json!({"row":0,"column":snapshot.cols,"rows":1,"columns":1}),
        json!({"row":0,"column":0,"rows":snapshot.rows+1,"columns":1}),
        json!({"row":0,"column":0,"rows":1,"columns":snapshot.cols+1}),
        json!({"row":usize::MAX,"column":0,"rows":1,"columns":1}),
    ] {
        let mut value = offer();
        value["placement"] = rect;
        assert!(admit(&value, &committed, &mut pool).is_err());
        assert_eq!(pool.reserved_bytes(), 0);
    }
    let mut value = offer();
    value["placement"] =
        json!({"row":snapshot.rows-1,"column":snapshot.cols-1,"rows":1,"columns":1});
    let accepted = admit(&value, &committed, &mut pool).unwrap();
    assert_eq!(accepted.placement().row, snapshot.rows - 1);
    assert_eq!(accepted.placement().column, snapshot.cols - 1);
}
