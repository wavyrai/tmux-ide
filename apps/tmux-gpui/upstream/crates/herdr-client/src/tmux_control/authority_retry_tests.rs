#![allow(clippy::unwrap_used)]
use super::*;
const GEN: &str = "12d14eac-0000-4000-8000-000000000001";
const CLIENT: &str = "gpui:test";
fn id(n: u32) -> String {
    format!("12d14eac-0000-4000-8000-0000000001{n:02}")
}
fn policy() -> Policy {
    let mut p = Policy::new(
        GEN.into(),
        "workspace".into(),
        CLIENT.into(),
        vec!["pane.one".into()],
        true,
    )
    .unwrap();
    p.ready(Some(CLIENT), true).unwrap();
    p
}
fn granted(request: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({"type":"authority-receipt","requestId":request,"authority":"input","status":"granted",
        "lease":{"generation":GEN,"session":"tmux-session","clientId":CLIENT,"authority":"input","token":"12d14eac-0000-4000-8000-000000000004","revision":1},
        "snapshot":{"generation":GEN,"session":"tmux-session","revision":1,"owners":{"input":CLIENT,"focus":null,"geometry":null},"nativeGeometryYieldUntilMs":0,"clients":[]}}))
    .unwrap()
}

/// Soak, 12 Nov 2026: the daemon did not answer the one input request of a
/// new stream; the stream showed frames and took no keys.
#[test]
fn an_unanswered_input_request_is_sent_again_five_times_at_most() {
    let mut p = policy();
    p.presence(true, &id(0), &id(50), 0).unwrap();
    let mut now = 0;
    for n in 1..=5 {
        // Not before the request lapsed.
        assert!(p.expire(now + 1999).unwrap().authorities.is_empty());
        now += 2000;
        let lapsed = p.expire(now).unwrap().authorities;
        assert_eq!(lapsed.len(), 1);
        let command = p.retry_input(&lapsed, &id(n), now).unwrap().unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(command.as_str()).unwrap(),
            json!({"type":"authority-request","generation":GEN,"requestId":id(n),"authority":"input"})
        );
        assert!(!p.owns(Authority::Input));
    }
    now += 2000;
    let lapsed = p.expire(now).unwrap().authorities;
    assert!(p.retry_input(&lapsed, &id(6), now).unwrap().is_none());
    // A new presence change asks again and gets its own retries.
    p.presence(false, &id(7), &id(51), now).unwrap();
    now += 2000;
    p.expire(now).unwrap();
    p.presence(true, &id(8), &id(52), now).unwrap();
    now += 2000;
    let lapsed = p.expire(now).unwrap().authorities;
    assert!(p.retry_input(&lapsed, &id(9), now).unwrap().is_some());
}

/// The answer to a retried request grants input like the first would have.
#[test]
fn the_receipt_for_a_retried_request_grants_input() {
    let mut p = policy();
    p.presence(true, &id(0), &id(50), 0).unwrap();
    let lapsed = p.expire(2000).unwrap().authorities;
    p.retry_input(&lapsed, &id(1), 2000).unwrap().unwrap();
    p.accept_json(&granted(&id(1))).unwrap();
    assert!(p.owns(Authority::Input));
    // Nothing more is asked once input is held.
    let lapsed = vec![(id(1), Authority::Input)];
    assert!(p.retry_input(&lapsed, &id(2), 4000).unwrap().is_none());
}

#[test]
fn nothing_is_asked_again_in_the_background_or_for_another_authority() {
    // A lapsed release in the background.
    let mut p = policy();
    p.presence(true, &id(0), &id(50), 0).unwrap();
    p.expire(2000).unwrap();
    p.presence(false, &id(1), &id(51), 2000).unwrap();
    let lapsed = p.expire(4000).unwrap().authorities;
    assert!(lapsed.iter().any(|(_, a)| *a == Authority::Input));
    assert!(p.retry_input(&lapsed, &id(2), 4000).unwrap().is_none());
    // An input request is still under way.
    let mut p = policy();
    p.presence(true, &id(0), &id(50), 0).unwrap();
    let lapsed = vec![(id(3), Authority::Input)];
    assert!(p.retry_input(&lapsed, &id(5), 100).unwrap().is_none());
    // Only a geometry request lapsed, with no input request under way.
    p.expire(2000).unwrap();
    let lapsed = vec![(id(3), Authority::Geometry)];
    assert!(p.retry_input(&lapsed, &id(4), 2000).unwrap().is_none());
}
