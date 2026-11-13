#![allow(clippy::unwrap_used)]
//! Capability 119: the input policy follows a pane change in place.
use super::*;
const GEN: &str = "12d14eac-0000-4000-8000-000000000001";
const REQUEST: &str = "12d14eac-0000-4000-8000-000000000002";
const GEOMETRY: &str = "12d14eac-0000-4000-8000-000000000003";
const CLIENT: &str = "gpui:test";
fn lifetime() -> Lifetime {
    Lifetime {
        generation: GEN.into(),
        incarnation: "pane:1".into(),
    }
}
fn granted() -> Policy {
    let mut p = Policy::new(
        GEN.into(),
        "workspace".into(),
        CLIENT.into(),
        vec!["pane.one".into(), "pane.two".into()],
        true,
    )
    .unwrap();
    p.ready(Some(CLIENT), true).unwrap();
    p.bind_lifetime("pane.one", Some(lifetime())).unwrap();
    p.bind_lifetime("pane.two", Some(lifetime())).unwrap();
    p.presence(true, REQUEST, GEOMETRY, 0).unwrap();
    p.accept_json(&serde_json::to_vec(&json!({"type":"authority-receipt","requestId":REQUEST,"authority":"input","status":"granted",
        "lease":{"generation":GEN,"session":"tmux-session","clientId":CLIENT,"authority":"input","token":"12d14eac-0000-4000-8000-000000000004","revision":1},
        "snapshot":{"generation":GEN,"session":"tmux-session","revision":1,"owners":{"input":CLIENT,"focus":null,"geometry":null},"nativeGeometryYieldUntilMs":0,"clients":[]}})).unwrap())
    .unwrap();
    p
}
fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(|pane| (*pane).to_owned()).collect()
}

#[test]
fn a_removed_pane_loses_its_lifetime_and_its_keys_in_flight_and_input_authority_stays() {
    let mut p = granted();
    p.input("pane.two", &lifetime(), Input::Text("x".into()), 0)
        .unwrap();
    p.input("pane.one", &lifetime(), Input::Text("y".into()), 0)
        .unwrap();
    let finished = p.follow(&names(&["pane.two"]), &[]).unwrap();
    assert_eq!(finished.len(), 1);
    assert_eq!(finished[0].pane, "pane.two");
    assert_eq!(finished[0].result, InputResult::AuthorityLost);
    // The stream's authority is not the pane's: the other pane types on.
    assert!(p.owns(Authority::Input));
    assert_eq!(p.pending_inputs(), 1);
    p.input("pane.one", &lifetime(), Input::Text("z".into()), 1)
        .unwrap();
    // The removed pane is no pane of this stream any more.
    assert!(matches!(
        p.input("pane.two", &lifetime(), Input::Text("x".into()), 1),
        Err(Error::Lifetime)
    ));
    assert!(matches!(
        p.bind_lifetime("pane.two", Some(lifetime())),
        Err(Error::Invalid)
    ));
}

#[test]
fn an_added_pane_takes_input_once_its_first_commit_binds_a_lifetime() {
    let mut p = granted();
    assert!(p.follow(&[], &names(&["pane.new"])).unwrap().is_empty());
    assert!(matches!(
        p.input("pane.new", &lifetime(), Input::Text("x".into()), 0),
        Err(Error::Lifetime)
    ));
    p.bind_lifetime("pane.new", Some(lifetime())).unwrap();
    p.input("pane.new", &lifetime(), Input::Text("x".into()), 0)
        .unwrap();
    // A pane id that left and came back starts its input sequence over.
    p.follow(&names(&["pane.new"]), &[]).unwrap();
    p.follow(&[], &names(&["pane.new"])).unwrap();
    p.bind_lifetime("pane.new", Some(lifetime())).unwrap();
    let command = p
        .input("pane.new", &lifetime(), Input::Text("x".into()), 0)
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(command.as_str()).unwrap()["seq"],
        1
    );
}

#[test]
fn a_change_that_does_not_fit_the_policys_panes_is_refused_whole() {
    let many: Vec<String> = (0..23).map(|n| format!("pane.n{n}")).collect();
    for (removed, added) in [
        (names(&["pane.gone"]), names(&[])),
        (names(&[]), names(&["pane.one"])),
        (names(&[]), names(&["../x"])),
        (names(&["pane.one", "pane.two"]), names(&[])),
        (names(&[]), many),
    ] {
        let mut p = granted();
        assert!(
            matches!(p.follow(&removed, &added), Err(Error::Invalid)),
            "{removed:?} {added:?}"
        );
        // Nothing was taken from a refused change.
        p.input("pane.two", &lifetime(), Input::Text("x".into()), 0)
            .unwrap();
    }
}
