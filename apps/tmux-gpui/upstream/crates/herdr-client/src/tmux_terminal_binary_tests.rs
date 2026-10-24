use super::*;
fn binary_negotiate() -> Event {
    let Event::DeliveryReady { pane, negotiation } = negotiate() else {
        panic!("negotiation")
    };
    let mut value: serde_json::Value = serde_json::from_str(negotiation.get()).unwrap();
    value["negotiated"]["encoding"] = json!("semantic-binary-v1");
    Event::DeliveryReady {
        pane,
        negotiation: to_raw_value(&value).unwrap(),
    }
}
#[test]
fn binary_offer_is_required_and_compact_fallback_is_accepted() {
    let mut old = state();
    old.apply(ready()).unwrap();
    assert!(matches!(
        old.apply(binary_negotiate()),
        Err(Error::Identity)
    ));
    for binary in [false, true] {
        let mut s = TerminalState::new_with_binary_cells(
            "generation".into(),
            "workspace".into(),
            vec!["pane.test".into()],
            true,
        )
        .unwrap();
        s.apply(ready()).unwrap();
        s.apply(if binary {
            binary_negotiate()
        } else {
            negotiate()
        })
        .unwrap();
        let vectors: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("tmux_delivery/tests/binary-vectors.json")).unwrap();
        let v = &vectors[0];
        let bytes: Vec<u8> = serde_json::from_value(v["bytes"].clone()).unwrap();
        let bytes = if binary {
            bytes
        } else {
            v["wire"].as_str().unwrap().as_bytes().to_vec()
        };
        let encoding = if binary {
            "semantic-binary-v1"
        } else {
            "semantic-compact-v1"
        };
        let e = json!({"type":"terminal.delivery","workspaceName":"workspace","semanticPaneId":"pane.test","generation":"generation","incarnation":"pane:1","deliveryNonce":"f8da3f73-66c3-4621-bf6f-547ee1d5fd1c","transactionId":"cc840bc1-d8af-4764-a586-c95befc44701","protocolVersion":1,"encoding":encoding,"frame":"seed","baseRevision":null,"canonicalRevision":1,"canonicalStateHash":v["canonicalHash"],"representationHash":crate::tmux_delivery::hash_representation(&bytes),"representationBytes":bytes.len(),"chunkCount":1,"canonicalEquivalent":true,"history":"complete","richPlacements":true});
        s.apply(Event::Envelope {
            pane: "pane.test".into(),
            envelope: to_raw_value(&e).unwrap(),
        })
        .unwrap();
        let event = if binary {
            Event::BinaryChunk {
                pane: "pane.test".into(),
                transaction_id: "cc840bc1-d8af-4764-a586-c95befc44701".into(),
                index: 0,
                data: bytes,
            }
        } else {
            Event::Chunk {
                pane: "pane.test".into(),
                transaction_id: "cc840bc1-d8af-4764-a586-c95befc44701".into(),
                index: 0,
                data: STANDARD.encode(bytes),
            }
        };
        assert!(matches!(
            s.apply(event),
            Ok(Outcome::Updated {
                snapshot: Some(_),
                ..
            })
        ));
    }
}
