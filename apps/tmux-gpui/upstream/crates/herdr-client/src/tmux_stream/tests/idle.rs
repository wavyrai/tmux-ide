//! #855: a pane stream with nothing to do leaves its thread asleep. Its 5 ms
//! read timeout used to wake it 200 times a second for as long as the stream
//! was open, one thread per open stream.
use std::{
    thread,
    time::{Duration, Instant},
};

use crossbeam_channel::bounded;
use tungstenite::Message;

use super::super::*;
use super::liveness::{hold_open, peer};

const WAIT: Duration = Duration::from_secs(3);

fn presence() -> Command {
    Command::from_json(r#"{"type":"presence"}"#.into()).unwrap()
}

#[test]
fn an_idle_stream_leaves_its_thread_asleep() {
    let (client, peer) = peer(None, hold_open);
    // Idle after a command too: the ring it made is heard once, not forever.
    client.try_send(presence()).unwrap();
    thread::sleep(Duration::from_millis(100));
    let before = client.wakes();
    thread::sleep(Duration::from_secs(1));
    let woke = client.wakes() - before;
    assert!(woke <= 2, "an idle stream woke {woke} times in one second");
    client.cancel();
    assert!(matches!(
        client.completion().recv_timeout(WAIT).unwrap(),
        Error::Cancelled
    ));
    peer.join().unwrap();
}

/// A key typed into an idle stream does not wait for a timer.
#[test]
fn a_command_wakes_an_idle_stream_at_once() {
    let (sent_tx, sent_rx) = bounded(1);
    let (client, peer) = peer(None, move |socket| {
        socket
            .get_mut()
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        for _ in 0..3 {
            let message = socket.read().unwrap();
            sent_tx.send((Instant::now(), message)).unwrap();
        }
        hold_open(socket);
    });
    for _ in 0..3 {
        thread::sleep(Duration::from_millis(200));
        let queued = Instant::now();
        client.try_send(presence()).unwrap();
        let (arrived, message) = sent_rx.recv_timeout(WAIT).unwrap();
        assert_eq!(message, Message::Text(r#"{"type":"presence"}"#.into()));
        let after = arrived - queued;
        assert!(after < Duration::from_millis(50), "sent after {after:?}");
    }
    drop(client);
    peer.join().unwrap();
}

/// Commands that keep coming wake the thread each time, but they do not put
/// off the silence limit of a daemon that stopped sending.
#[test]
fn commands_that_keep_coming_do_not_hide_a_silent_peer() {
    let started = Instant::now();
    let (client, peer) = peer(Some("interval-ms=250, missed-limit=2"), hold_open);
    let error = loop {
        if let Ok(error) = client.completion().recv_timeout(Duration::from_millis(40)) {
            break error;
        }
        assert!(started.elapsed() < WAIT, "a silent peer was never noticed");
        let _ = client.try_send(presence());
    };
    assert!(matches!(error, Error::Silent), "{error:?}");
    let after = started.elapsed();
    assert!(after < Duration::from_millis(2000), "ended after {after:?}");
    drop(client);
    peer.join().unwrap();
}

/// A full command queue goes out in batches without waiting for a ring.
#[test]
fn a_full_command_queue_is_sent_without_further_rings() {
    let (count_tx, count_rx) = bounded(1);
    let (client, peer) = peer(None, move |socket| {
        socket
            .get_mut()
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut count = 0;
        while count < 32 && matches!(socket.read(), Ok(Message::Text(_))) {
            count += 1;
        }
        count_tx.send(count).unwrap();
        hold_open(socket);
    });
    // Queued while the worker sleeps: it is woken once and finds all 32.
    thread::sleep(Duration::from_millis(100));
    for _ in 0..32 {
        client.try_send(presence()).unwrap();
    }
    assert_eq!(count_rx.recv_timeout(WAIT).unwrap(), 32);
    drop(client);
    peer.join().unwrap();
}

/// A daemon that upgrades the socket and never says ready is given up on
/// after five seconds, also while the worker sleeps.
#[test]
#[allow(clippy::result_large_err)] // tungstenite callback signature fixes the error type.
fn a_peer_that_never_says_ready_times_out() {
    use std::net::TcpListener;
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let options = super::transport::options(listener.local_addr().unwrap().port());
    let peer = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut socket = tungstenite::accept_hdr(
            stream,
            |_: &tungstenite::handshake::server::Request,
             mut response: tungstenite::handshake::server::Response| {
                (response.headers_mut())
                    .insert("Sec-WebSocket-Protocol", SUBPROTOCOL.parse().unwrap());
                Ok(response)
            },
        )
        .unwrap();
        hold_open(&mut socket);
    });
    let started = Instant::now();
    let client = PaneStream::spawn(options).unwrap();
    let error = client
        .completion()
        .recv_timeout(Duration::from_secs(10))
        .unwrap();
    assert!(matches!(error, Error::ReadyTimeout), "{error:?}");
    let after = started.elapsed();
    assert!(after < Duration::from_secs(7), "gave up after {after:?}");
    drop(client);
    peer.join().unwrap();
}
