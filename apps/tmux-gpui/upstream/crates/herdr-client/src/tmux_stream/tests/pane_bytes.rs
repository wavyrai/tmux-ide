use super::super::*;
/// Delivery frames count toward their pane's reconnect cost; control and
/// graphics frames don't name a pane.
#[test]
fn delivery_frames_report_their_pane_and_size() {
    let raw = |s: &str| serde_json::value::RawValue::from_string(s.into()).unwrap();
    let envelope = Event::Envelope {
        pane: "%1".into(),
        envelope: raw(r#"{"a":1}"#),
    };
    assert_eq!(envelope.pane_bytes(), Some(("%1", 7)));
    let chunk = Event::BinaryChunk {
        pane: "%2".into(),
        transaction_id: "t".into(),
        index: 0,
        data: vec![0; 300],
    };
    assert_eq!(chunk.pane_bytes(), Some(("%2", 300)));
    assert_eq!(Event::Control(raw("{}")).pane_bytes(), None);
    assert_eq!(Event::GraphicsBinary(vec![1, 2]).pane_bytes(), None);
}
