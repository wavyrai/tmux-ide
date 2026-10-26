#![allow(clippy::unwrap_used)]
use super::*;
use serde_json::json;
fn start(generation: Uuid) -> serde_json::Value {
    json!({"type":"start","connection":Uuid::new_v4(),"panes":["pane.editor"],
        "receiver":{"type":"terminal-surface-receiver","version":1,"generation":generation,
        "connectionNonce":Uuid::new_v4(),"challenge":Uuid::new_v4(),"pid":123,"slot":0,
        "auditToken":[1,2,3,4,5,6,7,8]}})
}
#[test]
fn production_start_preserves_receiver_kernel_proof_inputs() {
    let generation = Uuid::new_v4();
    let message = start(generation);
    let Event::Start {
        receiver, panes, ..
    } = Event::parse(message.to_string().as_bytes(), generation).unwrap()
    else {
        panic!("wrong event");
    };
    assert_eq!(receiver.generation, generation);
    assert_eq!(receiver.pid, 123);
    assert_eq!(receiver.audit_token, [1, 2, 3, 4, 5, 6, 7, 8]);
    assert_eq!(panes, ["pane.editor"]);
    assert!(matches!(
        Event::parse(message.to_string().as_bytes(), Uuid::new_v4()),
        Err(Error::Generation)
    ));
}
#[test]
fn rejects_overwide_authority_and_invalid_kernel_identity() {
    let generation = Uuid::new_v4();
    for (field, value) in [
        ("slot", json!(32)),
        ("pid", json!(0)),
        ("auditToken", json!([0, 0, 0, 0, 0, 0, 0, 0])),
        ("challenge", json!(Uuid::nil())),
    ] {
        let mut message = start(generation);
        message["receiver"][field] = value;
        assert!(Event::parse(message.to_string().as_bytes(), generation).is_err());
    }
    let mut message = start(generation);
    message["panes"] = json!(["pane.editor", "pane.editor"]);
    assert!(Event::parse(message.to_string().as_bytes(), generation).is_err());
    assert!(matches!(
        Event::parse(&vec![b' '; 16385], generation),
        Err(Error::Bounds)
    ));
}
#[test]
fn control_is_strict_and_preserves_offer_refusal() {
    let generation = Uuid::new_v4();
    let connection = Uuid::new_v4();
    let mut value = json!({"type":"offered","connection":connection,"sequence":1,"accepted":false});
    assert!(matches!(
        Event::parse(value.to_string().as_bytes(), generation),
        Ok(Event::Offered {
            accepted: false,
            ..
        })
    ));
    value["sequence"] = json!(0);
    assert!(Event::parse(value.to_string().as_bytes(), generation).is_err());
    value["sequence"] = json!(1);
    value["path"] = json!("/tmp/untrusted");
    assert!(Event::parse(value.to_string().as_bytes(), generation).is_err());
    let registration: serde_json::Value =
        serde_json::from_str(&register(generation, [1; 8]).unwrap()).unwrap();
    assert_eq!(
        registration,
        json!({"type":"register","version":1,"generation":generation,"auditToken":[1,1,1,1,1,1,1,1]})
    );
}

#[test]
fn demand_controls_are_bounded_unique_and_scoped_to_watched_panes() {
    let generation = Uuid::new_v4();
    let parse = |value: serde_json::Value| Event::parse(value.to_string().as_bytes(), generation);
    assert!(parse(json!({"type":"kitty-demand", "panes":["pane.one"], "required":[]})).is_ok());
    for value in [
        json!({"type":"kitty-demand", "panes":[], "required":[]}),
        json!({"type":"kitty-demand", "panes":["pane.one"], "required":["pane.other"]}),
        json!({"type":"kitty-demand", "panes":["pane.one", "pane.one"], "required":[]}),
        json!({"type":"kitty-demand", "panes":["pane.one", "pane.two"], "required":["pane.one", "pane.one"]}),
        json!({"type":"kitty-demand", "panes":["%1"], "required":[]}),
    ] {
        assert!(parse(value).is_err());
    }
    assert!(watch_demand(&[]).is_err());
    assert!(watch_demand(&vec!["pane.one".into(); 33]).is_err());
    let encoded = watch_demand(&["pane.one".into()]).unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&encoded).unwrap(),
        json!({"type":"watch-demand", "panes":["pane.one"]})
    );
}
