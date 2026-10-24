use super::*;
#[test]
fn cell_metrics_wait_for_support_deduplicate_and_never_request_geometry() {
    let (mut controller, observed, response, peer) = fixture();
    controller
        .set_cell_pixels(CellPixels {
            width: 9,
            height: 18,
            precise: Some((9250, 18250)),
        })
        .unwrap();
    controller.flush_cell_pixels(false, false).unwrap();
    assert!(observed.try_recv().is_err());
    controller.flush_cell_pixels(true, false).unwrap();
    let first = observed.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(
        first,
        json!({"type":"terminal-cell-pixels","width":9,"height":18})
    );
    controller.flush_cell_pixels(true, false).unwrap();
    response
        .send(json!({"type":"authority-snapshot","snapshot":authority()}))
        .unwrap();
    controller.flush_cell_pixels(true, true).unwrap();
    let precise = observed.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(
        precise,
        json!({"type":"terminal-cell-pixels","width":9,"height":18,"precise":{"width":9250,"height":18250}})
    );
    controller.retire();
    drop(response);
    peer.join().unwrap();
}
#[test]
fn invalid_cell_metrics_never_replace_pending_valid_metrics() {
    let (mut controller, _, response, peer) = fixture();
    let good = CellPixels {
        width: 9,
        height: 18,
        precise: None,
    };
    controller.set_cell_pixels(good.clone()).unwrap();
    assert!(matches!(
        controller.set_cell_pixels(CellPixels {
            width: 0,
            height: 18,
            precise: None
        }),
        Err(Error::Invalid)
    ));
    assert_eq!(controller.cell_pixels, Some(good));
    controller.retire();
    drop(response);
    peer.join().unwrap();
}
