//! PM, 12 Nov 2026: a peer that stops sending without closing must be noticed.
//! The daemon says in a header of the upgrade response how often it pings; only
//! then is silence a failure. A daemon that sends no header (2.9.22) does not
//! ping, so a quiet stream to it is never ended here.
use std::{
    net::{TcpListener, TcpStream},
    thread,
    time::{Duration, Instant},
};

use tungstenite::{
    Message, WebSocket,
    handshake::server::{Request, Response},
};

use super::super::*;
use super::transport::{options, ready};

const WAIT: Duration = Duration::from_secs(3);

#[allow(clippy::result_large_err)] // tungstenite callback signature fixes the error type.
fn accept(listener: TcpListener, heartbeat: Option<&'static str>) -> WebSocket<TcpStream> {
    let (stream, _) = listener.accept().unwrap();
    stream.set_read_timeout(Some(WAIT)).unwrap();
    stream.set_write_timeout(Some(WAIT)).unwrap();
    let mut socket = tungstenite::accept_hdr(stream, |_: &Request, mut response: Response| {
        let headers = response.headers_mut();
        headers.insert("Sec-WebSocket-Protocol", SUBPROTOCOL.parse().unwrap());
        if let Some(heartbeat) = heartbeat {
            headers.insert("x-tmux-ide-heartbeat", heartbeat.parse().unwrap());
        }
        Ok(response)
    })
    .unwrap();
    socket.read().unwrap();
    socket.send(Message::Text(ready().into())).unwrap();
    socket
}
/// A peer that is ready and then does `then` until the client is gone.
fn peer(
    heartbeat: Option<&'static str>,
    then: impl FnOnce(&mut WebSocket<TcpStream>) + Send + 'static,
) -> (PaneStream, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let options = options(listener.local_addr().unwrap().port());
    let peer = thread::spawn(move || {
        let mut socket = accept(listener, heartbeat);
        then(&mut socket);
    });
    let client = PaneStream::spawn(options).unwrap();
    assert!(matches!(
        client.events().recv_timeout(WAIT).unwrap(),
        Event::Ready(_)
    ));
    (client, peer)
}
fn hold_open(socket: &mut WebSocket<TcpStream>) {
    socket
        .get_mut()
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    while socket.read().is_ok() {}
}

/// 250 ms x 2 missed, plus one interval of slack: dead after 750 ms of silence.
#[test]
fn a_silent_peer_that_advertised_a_heartbeat_ends_the_stream() {
    let started = Instant::now();
    let (client, peer) = peer(Some("interval-ms=250, missed-limit=2"), hold_open);
    let error = client.completion().recv_timeout(WAIT).unwrap();
    assert!(matches!(error, Error::Silent), "{error:?}");
    let after = started.elapsed();
    assert!(
        after >= Duration::from_millis(750) && after < Duration::from_millis(2000),
        "ended after {after:?}"
    );
    drop(client);
    peer.join().unwrap();
}

/// What a 2.9.22 daemon does: no header, no pings. Quiet is not dead.
#[test]
fn a_silent_peer_without_the_header_is_never_ended() {
    for header in [
        None,
        Some("interval-ms=250"),
        Some("interval-ms=0, missed-limit=2"),
        Some("interval-ms=100, missed-limit=2"),
        Some("interval-ms=250, missed-limit=0"),
        Some("interval-ms=70000, missed-limit=2"),
        Some("interval-ms=250,missed-limit=2"),
        Some("interval-ms=250, missed-limit=2, more=1"),
    ] {
        let (client, peer) = peer(header, hold_open);
        assert!(
            client
                .completion()
                .recv_timeout(Duration::from_millis(1200))
                .is_err(),
            "a quiet stream was ended with header {header:?}"
        );
        drop(client);
        peer.join().unwrap();
    }
}

/// Pings alone keep the stream: nothing else is sent. And each one is
/// answered, which is what keeps the daemon from dropping this client.
#[test]
fn pings_keep_a_quiet_stream_alive_and_are_answered() {
    let (pongs_tx, pongs_rx) = crossbeam_channel::bounded(1);
    let (client, peer) = peer(Some("interval-ms=250, missed-limit=2"), move |socket| {
        socket
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(50)))
            .unwrap();
        let mut pongs = 0;
        for _ in 0..8 {
            socket.send(Message::Ping(Vec::new().into())).unwrap();
            let until = Instant::now() + Duration::from_millis(250);
            while Instant::now() < until {
                if let Ok(Message::Pong(_)) = socket.read() {
                    pongs += 1;
                }
            }
        }
        pongs_tx.send(pongs).unwrap();
        hold_open(socket);
    });
    // Two seconds of pings and nothing else: well past the 750 ms limit.
    assert_eq!(pongs_rx.recv_timeout(Duration::from_secs(5)).unwrap(), 8);
    assert!(client.completion().try_recv().is_err());
    // The pings stop: the limit applies from the last one.
    let error = client.completion().recv_timeout(WAIT).unwrap();
    assert!(matches!(error, Error::Silent), "{error:?}");
    drop(client);
    peer.join().unwrap();
}

#[test]
fn the_header_is_parsed_exactly_as_the_daemon_writes_it() {
    use crate::tmux_heartbeat::Heartbeat;
    let silence = |value| Heartbeat::parse(value).map(|heartbeat| heartbeat.silence());
    // The daemon's defaults: 10 s x 3, plus one interval.
    assert_eq!(
        silence("interval-ms=10000, missed-limit=3"),
        Some(Duration::from_secs(40))
    );
    assert_eq!(
        silence("interval-ms=250, missed-limit=1"),
        Some(Duration::from_millis(500))
    );
    assert_eq!(
        silence("interval-ms=60000, missed-limit=99"),
        Some(Duration::from_secs(6000))
    );
    for malformed in [
        "",
        "interval-ms=249, missed-limit=3",
        "interval-ms=60001, missed-limit=3",
        "interval-ms=010000, missed-limit=3",
        "interval-ms=10000, missed-limit=100",
        "interval-ms=10000, missed-limit=03",
        "interval-ms=-1, missed-limit=3",
        "interval-ms=10000, missed-limit=3 ",
        "missed-limit=3, interval-ms=10000",
        "interval-ms=1e4, missed-limit=3",
    ] {
        assert_eq!(silence(malformed), None, "{malformed:?}");
    }
}
