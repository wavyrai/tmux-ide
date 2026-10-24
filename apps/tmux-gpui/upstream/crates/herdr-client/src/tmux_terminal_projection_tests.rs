use super::*;
#[test]
fn projection_negotiation_requires_explicit_trusted_offer_but_allows_old_daemon() {
    let mut value = if let Event::DeliveryReady { negotiation, .. } = negotiate() {
        serde_json::from_str::<serde_json::Value>(negotiation.get()).unwrap()
    } else {
        panic!("ready")
    };
    value["negotiated"]["encoding"] = json!("semantic-binary-v1");
    value["negotiated"]["alternateScreenProjection"] = json!("deferred-history-v1");
    let mut unoffered = TerminalState::new_with_binary_cells(
        "generation".into(),
        "workspace".into(),
        vec!["pane.test".into()],
        true,
    )
    .unwrap();
    unoffered.apply(ready()).unwrap();
    assert!(
        unoffered
            .apply(Event::DeliveryReady {
                pane: "pane.test".into(),
                negotiation: to_raw_value(&value).unwrap()
            })
            .is_err()
    );
    for projected in [false, true] {
        let mut state = TerminalState::new_offered(
            "generation".into(),
            "workspace".into(),
            vec!["pane.test".into()],
            true,
            true,
        )
        .unwrap();
        state.apply(ready()).unwrap();
        state
            .apply(if projected {
                Event::DeliveryReady {
                    pane: "pane.test".into(),
                    negotiation: to_raw_value(&value).unwrap(),
                }
            } else {
                negotiate()
            })
            .unwrap();
    }
}
