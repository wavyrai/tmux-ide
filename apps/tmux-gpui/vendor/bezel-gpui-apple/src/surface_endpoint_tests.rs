use super::*;

#[test]
fn mutual_endpoint_exchange_carries_no_pixel_right_before_receiver_proof() {
    let peer = SenderIdentity::current().unwrap();
    let (mut rendezvous, public) = Inbox::new().unwrap();
    let (mut reply, reply_endpoint) = Inbox::new().unwrap();
    let (mut pixels, pixel_endpoint) = Inbox::new().unwrap();
    let challenge = [9; 16];
    assert_eq!(
        public
            .try_send_endpoint(&reply_endpoint, challenge)
            .unwrap(),
        SendStatus::Queued
    );
    let producer_reply = rendezvous
        .try_receive_endpoint(peer, challenge)
        .unwrap()
        .unwrap();
    assert!(pixels.try_receive_next().unwrap().is_none());
    assert_eq!(
        producer_reply
            .try_send_endpoint(&pixel_endpoint, challenge)
            .unwrap(),
        SendStatus::Queued
    );
    let verified_receiver = reply
        .try_receive_endpoint(peer, challenge)
        .unwrap()
        .unwrap();
    let (_storage, carried) = Inbox::new().unwrap();
    assert_eq!(
        verified_receiver.send_named(carried.0, [1; 16], 1).unwrap(),
        SendStatus::Queued
    );
    assert!(pixels.try_receive_from(peer).unwrap().is_some());
    // The handshake is a one-use exchange; reuse requires a fresh reply inbox.
    assert_eq!(
        producer_reply
            .try_send_endpoint(&pixel_endpoint, challenge)
            .unwrap(),
        SendStatus::Queued
    );
    assert!(reply.try_receive_endpoint(peer, challenge).is_err());
}

#[test]
fn endpoint_proof_rejects_wrong_peer_challenge_and_surface_message_kind() {
    let peer = SenderIdentity::current().unwrap();
    let mut wrong = peer.token();
    wrong[7] ^= 1;
    let wrong = SenderIdentity::from_authenticated_token(wrong).unwrap();
    let (mut inbox, endpoint) = Inbox::new().unwrap();
    let (_other, carried) = Inbox::new().unwrap();
    endpoint.try_send_endpoint(&carried, [1; 16]).unwrap();
    assert!(inbox.try_receive_endpoint(wrong, [1; 16]).is_err());
    endpoint.try_send_endpoint(&carried, [2; 16]).unwrap();
    assert!(inbox.try_receive_endpoint(peer, [1; 16]).is_err());
    endpoint.send_named(carried.0, [1; 16], 1).unwrap();
    assert!(inbox.try_receive_endpoint(peer, [1; 16]).is_err());
    endpoint.try_send_endpoint(&carried, [1; 16]).unwrap();
    assert!(inbox.try_receive_endpoint(peer, [1; 16]).unwrap().is_some());
}

#[test]
fn endpoint_proof_cannot_be_imported_as_a_surface() {
    let (mut inbox, endpoint) = Inbox::new().unwrap();
    let (_other, carried) = Inbox::new().unwrap();
    endpoint.try_send_endpoint(&carried, [1; 16]).unwrap();
    assert!(inbox.try_receive_next().is_err());
    assert!(inbox.try_receive_next().unwrap().is_none());
}
