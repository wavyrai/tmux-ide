//! Reconnect reliability (19 Nov 2026): a link that died without closing is
//! found from our own unanswered ping in a few seconds, not after the daemon's
//! 40 s heartbeat limit, and never while the link is busy or only slow.
use std::{
    net::TcpStream,
    thread,
    time::{Duration, Instant},
};

use crossbeam_channel::bounded;
use tungstenite::{Message, WebSocket};

use super::super::*;
use super::liveness::{hold_open, peer};

const WAIT: Duration = Duration::from_secs(5);

/// Streams spawned in `f` ping every `every_ms` and give a ping `limit_ms`.
fn with_limits<T>(every_ms: u64, limit_ms: u64, f: impl FnOnce() -> T) -> T {
    worker::PING_EVERY_MS.with(|period| period.set(Some(every_ms)));
    pinger::PONG_LIMIT_MS.with(|limit| limit.set(Some(limit_ms)));
    let result = f();
    worker::PING_EVERY_MS.with(|period| period.set(None));
    pinger::PONG_LIMIT_MS.with(|limit| limit.set(None));
    result
}
/// A peer whose link died: it reads nothing and sends nothing, and the
/// socket stays open (an SSH forward on a network that went away).
fn dead(socket: &mut WebSocket<TcpStream>) {
    thread::sleep(Duration::from_secs(4));
    let _ = socket.close(None);
}

#[test]
fn an_unanswered_ping_on_a_silent_link_ends_the_stream() {
    let started = Instant::now();
    let (client, peer) = with_limits(100, 400, || peer(None, dead));
    let error = client.completion().recv_timeout(WAIT).unwrap();
    assert!(matches!(error, Error::Silent), "{error:?}");
    // First ping at 100 ms, then 400 ms with nothing: about 0.5 s.
    let after = started.elapsed();
    assert!(
        after >= Duration::from_millis(500) && after < Duration::from_millis(1500),
        "ended after {after:?}"
    );
    drop(client);
    peer.join().unwrap();
}

/// A peer that answers late, but within the limit, is alive.
#[test]
fn a_slow_answer_keeps_the_stream() {
    // Answers come up to about 650 ms late; the limit is 1 s.
    let (client, peer) = with_limits(100, 1000, || {
        peer(None, |socket| {
            socket
                .get_mut()
                .set_read_timeout(Some(Duration::from_millis(20)))
                .unwrap();
            let until = Instant::now() + Duration::from_millis(2500);
            while Instant::now() < until {
                // tungstenite queues the pong as it reads the ping and
                // writes it on the next call: read only every 300 ms.
                let _ = socket.read();
                thread::sleep(Duration::from_millis(300));
            }
            hold_open(socket);
        })
    });
    assert!(
        client
            .completion()
            .recv_timeout(Duration::from_millis(2500))
            .is_err(),
        "a slow link was ended"
    );
    drop(client);
    peer.join().unwrap();
}

/// A busy link whose answer waits behind its output is alive: output that
/// keeps arriving counts, even with no pong at all.
#[test]
fn output_that_keeps_coming_keeps_the_stream_without_a_pong() {
    let (client, peer) = with_limits(100, 400, || {
        peer(None, |socket| {
            let until = Instant::now() + Duration::from_millis(2000);
            while Instant::now() < until {
                // Never reads, so never answers a ping.
                socket
                    .send(Message::Ping(b"daemon".to_vec().into()))
                    .unwrap();
                thread::sleep(Duration::from_millis(100));
            }
            hold_open(socket);
        })
    });
    assert!(
        client
            .completion()
            .recv_timeout(Duration::from_millis(2000))
            .is_err(),
        "a busy link was ended"
    );
    drop(client);
    peer.join().unwrap();
}

/// A probe (the Mac woke, the network changed) pings at once, not at the
/// next period, and says so until the answer comes.
#[test]
fn a_probe_pings_at_once_and_waits_for_the_answer() {
    let (pinged_tx, pinged_rx) = bounded(4);
    let (client, peer) = peer(None, move |socket| {
        socket
            .get_mut()
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        while let Ok(message) = socket.read() {
            if let Message::Ping(_) = message {
                let _ = pinged_tx.send(Instant::now());
            }
        }
    });
    thread::sleep(Duration::from_millis(100));
    assert!(!client.probing());
    let asked = Instant::now();
    client.probe();
    assert!(client.probing(), "a probe that waits says so");
    let pinged = pinged_rx.recv_timeout(WAIT).unwrap();
    assert!(
        pinged - asked < Duration::from_millis(100),
        "{:?}",
        pinged - asked
    );
    let started = Instant::now();
    while client.probing() {
        assert!(started.elapsed() < WAIT, "the answer never ended the probe");
        thread::sleep(Duration::from_millis(5));
    }
    assert!(client.completion().try_recv().is_err());
    drop(client);
    peer.join().unwrap();
}

/// A probe on a dead link ends the stream after the pong limit.
#[test]
fn a_probe_on_a_dead_link_ends_the_stream_after_the_limit() {
    let (client, peer) = with_limits(60_000, 400, || peer(None, dead));
    thread::sleep(Duration::from_millis(100));
    let asked = Instant::now();
    client.probe();
    let error = client.completion().recv_timeout(WAIT).unwrap();
    assert!(matches!(error, Error::Silent), "{error:?}");
    let after = asked.elapsed();
    assert!(
        after >= Duration::from_millis(400) && after < Duration::from_millis(1200),
        "ended after {after:?}"
    );
    drop(client);
    peer.join().unwrap();
}

/// A key sent on a link that has been quiet is followed by a ping, so a key
/// typed into a dead link is found at the limit, not at the next period.
#[test]
fn a_key_on_a_quiet_dead_link_is_found_at_the_limit() {
    let (client, peer) = with_limits(60_000, 400, || peer(None, dead));
    // Quiet for longer than a second: the next command brings a ping.
    thread::sleep(Duration::from_millis(1100));
    let typed = Instant::now();
    client
        .try_send(Command::from_json(r#"{"type":"presence"}"#.into()).unwrap())
        .unwrap();
    let error = client.completion().recv_timeout(WAIT).unwrap();
    assert!(matches!(error, Error::Silent), "{error:?}");
    let after = typed.elapsed();
    assert!(after < Duration::from_millis(1200), "ended after {after:?}");
    drop(client);
    peer.join().unwrap();
}
