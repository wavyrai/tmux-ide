use super::super::*;
use std::{
    io::{Read, Write},
    net::TcpListener,
    thread,
    time::Duration,
};
const WAIT: Duration = Duration::from_secs(3);
fn fixture() -> (crate::tmux_ssh::PeerIdentity, serde_json::Value) {
    let daemon = serde_json::json!({"pid":123,"port":4111,"protocolVersion":4,"productVersion":"2.9.12","instanceId":"e01ce8ee-74d8-40d0-9a59-a096050a6ade","startedAt":"2026-10-25T02:00:00Z","bindHostname":"127.0.0.1","authToken":"secret-fixture"});
    let descriptor = crate::tmux_ssh::RemoteDescriptor::parse(
        &serde_json::to_vec(&serde_json::json!({"version":1,"daemon":daemon})).unwrap(),
        None,
    )
    .unwrap();
    let mut identity = daemon;
    identity["ok"] = true.into();
    (descriptor.peer_identity(), identity)
}
#[test]
fn remote_stream_proves_socket_before_upgrade_and_redemption() {
    for matches in [true, false] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let options = super::transport::options(listener.local_addr().unwrap().port());
        let (expected, mut identity) = fixture();
        if !matches {
            identity["pid"] = 456.into();
        }
        let peer = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(WAIT)).unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                stream.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
                assert!(request.len() < 8192);
            }
            let request = String::from_utf8(request).unwrap().to_ascii_lowercase();
            assert!(request.starts_with("get /identity "));
            assert!(
                !request.contains("authorization")
                    && !request.contains("upgrade")
                    && !request.contains("ps2_")
            );
            let body = serde_json::to_vec(&identity).unwrap();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(&body).unwrap();
            if !matches {
                let mut byte = [0];
                assert_eq!(stream.read(&mut byte).unwrap(), 0);
                return;
            }
            #[allow(clippy::result_large_err)]
            fn upgrade(
                _: &tungstenite::handshake::server::Request,
                mut response: tungstenite::handshake::server::Response,
            ) -> Result<
                tungstenite::handshake::server::Response,
                tungstenite::handshake::server::ErrorResponse,
            > {
                response
                    .headers_mut()
                    .insert("Sec-WebSocket-Protocol", SUBPROTOCOL.parse().unwrap());
                Ok(response)
            }
            let mut socket = tungstenite::accept_hdr(stream, upgrade).unwrap();
            let redemption = socket.read().unwrap().into_text().unwrap();
            assert!(redemption.contains("ps2_"));
            socket
                .send(tungstenite::Message::Text(super::transport::ready().into()))
                .unwrap();
        });
        let client = PaneStream::spawn_remote(options, expected).unwrap();
        if matches {
            assert!(matches!(
                client.events().recv_timeout(WAIT).unwrap(),
                Event::Ready(_)
            ));
        } else {
            assert!(matches!(
                client.completion().recv_timeout(WAIT).unwrap(),
                Error::RemoteIdentity(_)
            ));
        }
        peer.join().unwrap();
        client.cancel();
    }
}
