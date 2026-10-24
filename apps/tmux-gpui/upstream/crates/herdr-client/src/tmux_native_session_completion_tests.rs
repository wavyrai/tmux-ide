use super::*;

#[test]
fn socket_close_preserves_the_transport_result_when_both_channels_are_ready() {
    for _ in 0..12 {
        let (listener, options) = fixture();
        let peer = thread::spawn(move || {
            let mut socket = accept(listener);
            socket.close(None).unwrap();
        });
        let session = NativeSession::spawn(options, "workspace".into()).unwrap();
        until(|| match session.drain().unwrap().status {
            Status::Failed(error) => {
                assert!(
                    matches!(*error, Error::Transport(_)),
                    "lost transport failure: {error:?}"
                );
                Some(())
            }
            _ => None,
        });
        peer.join().unwrap();
    }
}
