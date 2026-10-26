use super::*;
use crate::{surface_receiver::Receiver, surface_rendezvous::Registration};
use std::time::Duration;
fn registration() -> Registration {
    let mut attempt = Registration::begin().unwrap();
    loop {
        if let Some(registration) = attempt.poll().unwrap() {
            return registration;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}
#[test]
fn producer_waits_for_reciprocal_kernel_proof() {
    let registration = registration();
    let peer = SenderIdentity::current().unwrap();
    let now = Instant::now();
    let deadline = now + Duration::from_secs(5);
    let mut sender = Sender::new(
        std::process::id(),
        registration.slot(),
        peer,
        [1; 16],
        deadline,
    )
    .unwrap();
    assert!(!sender.poll(now).unwrap());
    assert!(!sender.ready());
    let mut receiver = Receiver::new(registration, peer, [1; 16], deadline).unwrap();
    assert!(receiver.poll(now).unwrap());
    assert!(sender.poll(now).unwrap());
    assert!(sender.ready());
    sender.close();
    assert!(!sender.ready());
    assert!(sender.poll(now).is_err());
}
#[test]
fn wrong_kernel_peer_never_exposes_pixel_endpoint() {
    let registration = registration();
    let actual = SenderIdentity::current().unwrap();
    let mut token = actual.token();
    token[7] ^= 1;
    let wrong = SenderIdentity::from_authenticated_token(token).unwrap();
    let now = Instant::now();
    let deadline = now + Duration::from_secs(5);
    let mut sender = Sender::new(
        std::process::id(),
        registration.slot(),
        wrong,
        [1; 16],
        deadline,
    )
    .unwrap();
    assert!(!sender.poll(now).unwrap());
    let mut receiver = Receiver::new(registration, actual, [1; 16], deadline).unwrap();
    assert!(receiver.poll(now).unwrap());
    assert!(sender.poll(now).is_err());
    assert!(!sender.ready());
    assert!(sender.poll(now).is_err());
}
#[test]
fn absent_reciprocal_proof_expires_once_without_reopening() {
    let registration = registration();
    let now = Instant::now();
    let mut sender = Sender::new(
        std::process::id(),
        registration.slot(),
        SenderIdentity::current().unwrap(),
        [1; 16],
        now + Duration::from_secs(5),
    )
    .unwrap();
    assert!(!sender.poll(now).unwrap());
    assert!(!sender.poll(now + Duration::from_secs(4)).unwrap());
    assert!(sender.poll(now + Duration::from_secs(5)).is_err());
    assert!(!sender.ready());
    assert!(sender.poll(now).is_err());
}
