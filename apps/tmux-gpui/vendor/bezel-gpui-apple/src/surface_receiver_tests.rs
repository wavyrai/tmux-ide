use super::*;
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
fn timeout_revokes_endpoints_and_cannot_reopen_receiver() {
    let registration = registration();
    let endpoint =
        crate::surface_rendezvous::lookup_unverified(std::process::id(), registration.slot())
            .unwrap()
            .unwrap();
    let now = Instant::now();
    let mut receiver = Receiver::new(
        registration,
        SenderIdentity::current().unwrap(),
        [1; 16],
        now + Duration::from_secs(5),
    )
    .unwrap();
    assert!(!receiver.poll(now).unwrap());
    assert!(receiver.try_receive().is_err());
    assert!(receiver.poll(now + Duration::from_secs(5)).is_err());
    assert!(!receiver.ready());
    assert!(receiver.poll(now).is_err());
    let (_reply, reply_endpoint) = Inbox::new().unwrap();
    assert!(endpoint.try_send_proof(&reply_endpoint, [1; 16]).is_err());
}
#[test]
fn backpressured_reciprocal_proof_is_not_ready_and_times_out() {
    let registration = registration();
    let endpoint =
        crate::surface_rendezvous::lookup_unverified(std::process::id(), registration.slot())
            .unwrap()
            .unwrap();
    let (_reply, reply_endpoint) = Inbox::new().unwrap();
    // Fill the one-slot peer queue before advertising it. The receiver must not
    // report proof completion just because it has received the producer endpoint.
    assert_eq!(
        reply_endpoint
            .try_send_endpoint(&reply_endpoint, [2; 16])
            .unwrap(),
        SendStatus::Queued
    );
    assert_eq!(
        endpoint.try_send_proof(&reply_endpoint, [1; 16]).unwrap(),
        SendStatus::Queued
    );
    let now = Instant::now();
    let mut receiver = Receiver::new(
        registration,
        SenderIdentity::current().unwrap(),
        [1; 16],
        now + Duration::from_secs(5),
    )
    .unwrap();
    assert!(!receiver.poll(now).unwrap());
    assert!(!receiver.ready());
    assert!(!receiver.poll(now + Duration::from_secs(1)).unwrap());
    assert!(receiver.poll(now + Duration::from_secs(5)).is_err());
    assert!(!receiver.ready());
}
#[test]
fn wrong_challenge_closes_receiver_without_exposing_pixel_endpoint() {
    let registration = registration();
    let endpoint =
        crate::surface_rendezvous::lookup_unverified(std::process::id(), registration.slot())
            .unwrap()
            .unwrap();
    let (mut reply, reply_endpoint) = Inbox::new().unwrap();
    let peer = SenderIdentity::current().unwrap();
    assert_eq!(
        endpoint.try_send_proof(&reply_endpoint, [2; 16]).unwrap(),
        SendStatus::Queued
    );
    let now = Instant::now();
    let mut receiver =
        Receiver::new(registration, peer, [1; 16], now + Duration::from_secs(5)).unwrap();
    assert!(receiver.poll(now).is_err());
    assert!(!receiver.ready());
    assert!(reply.try_receive_endpoint(peer, [1; 16]).unwrap().is_none());
    assert!(receiver.poll(now).is_err());
}
