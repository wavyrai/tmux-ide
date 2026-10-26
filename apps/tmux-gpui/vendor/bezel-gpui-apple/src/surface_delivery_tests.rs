use super::*;

fn send(endpoint: &SendRight, carried: &SendRight, ticket: [u8; 16], sequence: u64) {
    assert_eq!(
        endpoint
            .send_named(carried.borrowed_name(), ticket, sequence)
            .unwrap(),
        SendStatus::Queued
    );
}

#[test]
fn receiver_returns_correlation_without_guessing_next_control_offer() {
    let (mut inbox, endpoint) = Inbox::new().unwrap();
    let (_storage, carried) = Inbox::new().unwrap();
    assert!(inbox.try_receive_next().unwrap().is_none());
    send(&endpoint, &carried, [3; 16], 7);
    let delivery = inbox.try_receive_next().unwrap().unwrap();
    assert_eq!(delivery.ticket, [3; 16]);
    assert_eq!(delivery.sequence, 7);
    drop(delivery); // An unmatched control offer must release this capability.
    send(&endpoint, &carried, [4; 16], 8);
    let delivery = inbox.try_receive_next().unwrap().unwrap();
    assert_eq!(delivery.sequence, 8);
}

#[test]
fn dropped_unmatched_delivery_cannot_be_replayed_or_block_later_delivery() {
    let (mut inbox, endpoint) = Inbox::new().unwrap();
    let (_storage, carried) = Inbox::new().unwrap();
    send(&endpoint, &carried, [1; 16], 9);
    drop(inbox.try_receive_next().unwrap().unwrap());
    for sequence in [9, 8] {
        send(&endpoint, &carried, [2; 16], sequence);
        assert!(inbox.try_receive_next().is_err());
        assert!(inbox.try_receive_next().unwrap().is_none());
    }
    send(&endpoint, &carried, [3; 16], 10);
    assert_eq!(inbox.try_receive_next().unwrap().unwrap().sequence, 10);
}

#[test]
fn strict_and_unpredicted_receivers_share_the_same_replay_boundary() {
    let (mut inbox, endpoint) = Inbox::new().unwrap();
    let (_storage, carried) = Inbox::new().unwrap();
    send(&endpoint, &carried, [1; 16], 1);
    drop(inbox.try_receive([1; 16], 1).unwrap().unwrap());
    send(&endpoint, &carried, [2; 16], 1);
    assert!(inbox.try_receive_next().is_err());
    send(&endpoint, &carried, [3; 16], 2);
    drop(inbox.try_receive_next().unwrap().unwrap());
    assert!(inbox.try_receive([3; 16], 2).is_err());
}

#[test]
fn kernel_sender_binding_rejects_wrong_incarnation_without_advancing_sequence() {
    let (mut probe, probe_endpoint) = Inbox::new().unwrap();
    let (_storage, carried) = Inbox::new().unwrap();
    send(&probe_endpoint, &carried, [1; 16], 1);
    let sender = probe.try_receive_next().unwrap().unwrap().sender;
    assert!(sender == SenderIdentity::current().unwrap());
    let mut wrong = sender.token();
    // Compare the complete token, including the kernel process incarnation.
    wrong[7] ^= 1;
    let wrong = SenderIdentity::from_authenticated_token(wrong).unwrap();
    let (mut inbox, endpoint) = Inbox::new().unwrap();
    send(&endpoint, &carried, [2; 16], 100);
    assert!(inbox.try_receive_from(wrong).is_err());
    assert!(inbox.try_receive_from(sender).unwrap().is_none());
    // A rejected peer cannot poison the sequence boundary for the valid peer.
    send(&endpoint, &carried, [3; 16], 1);
    let accepted = inbox.try_receive_from(sender).unwrap().unwrap();
    assert!(accepted.sender == sender);
    assert_eq!(accepted.sequence, 1);
    assert_eq!(accepted.ticket, [3; 16]);
    assert!(SenderIdentity::from_authenticated_token([0; 8]).is_err());
}
