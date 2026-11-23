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

/// A wake or a network change probes every open stream, and forgets the
/// ended ones. A stream is registered for it from its start.
#[test]
fn probing_all_streams_reaches_the_open_ones_and_forgets_the_ended() {
    let (open, open_peer) = peer(None, hold_open);
    let (ended, ended_peer) = peer(None, |socket| {
        let _ = socket.close(None);
        hold_open(socket);
    });
    assert!(open.registered() && ended.registered());
    ended.completion().recv_timeout(WAIT).unwrap();
    assert!(!open.probing());
    assert_eq!(PaneStream::probe_only(&[&open, &ended]), 1);
    assert!(open.probing(), "the open stream was not probed");
    assert!(!ended.probing(), "an ended stream was probed");
    // Asked directly, an ended stream has no probe to wait for either.
    ended.probe();
    assert!(!ended.probing());
    let started = Instant::now();
    while open.probing() {
        assert!(started.elapsed() < WAIT, "the answer never ended the probe");
        thread::sleep(Duration::from_millis(5));
    }
    drop((open, ended));
    open_peer.join().unwrap();
    ended_peer.join().unwrap();
}

/// A few seconds, and well inside the daemon's 40 s heartbeat limit.
#[test]
fn a_ping_waits_five_seconds_for_its_answer_by_default() {
    assert_eq!(pinger::pong_limit(), Duration::from_secs(5));
}

mod timer {
    //! The ping timer on its own, at its exact limits.
    use super::super::super::pinger::Pinger;
    use std::time::{Duration, Instant};

    const EVERY: Duration = Duration::from_secs(10);
    const LIMIT: Duration = Duration::from_secs(5);
    const MS: Duration = Duration::from_millis(1);
    const ID: [u8; 8] = *b"ping-one";

    /// A timer made at `start`, and `start` itself.
    fn timer() -> (Pinger, Instant) {
        let before = Instant::now();
        let pinger = Pinger::new(EVERY, LIMIT);
        // The first ping is due one period after the timer was made.
        let made = (0..=1_000)
            .map(|ms| before + MS * ms)
            .find(|at| pinger.due(*at + EVERY, *at + EVERY, false, false))
            .unwrap();
        (pinger, made)
    }

    #[test]
    fn a_ping_is_due_at_the_period_on_a_probe_or_after_a_key_on_a_quiet_link() {
        let (pinger, start) = timer();
        let heard = start;
        assert!(!pinger.due(start + EVERY - MS * 2, heard, false, false));
        assert!(pinger.due(start + EVERY, heard, false, false));
        // A probe pings now.
        assert!(pinger.due(start, heard, true, false));
        // A key on a link quiet for a second brings a ping; on a link that
        // was just heard, or with no key, none.
        let second = Duration::from_secs(1);
        assert!(pinger.due(start + second, heard, false, true));
        assert!(!pinger.due(start + second - MS, heard, false, true));
        assert!(!pinger.due(start + second, heard, false, false));
        assert!(!pinger.due(start + second * 3, start + second * 3, false, true));
    }

    #[test]
    fn one_ping_waits_at_a_time_and_the_next_follows_a_period_later() {
        let (mut pinger, start) = timer();
        let at = start + EVERY;
        pinger.sent(ID, at);
        // Nothing asks for a second ping while the first waits.
        assert!(!pinger.due(at + EVERY * 2, start, true, true));
        // Another ping's answer is not ours.
        assert!(pinger.pong(b"ping-two").is_none());
        assert!(pinger.pong(b"ping").is_none());
        assert!(!pinger.due(at + EVERY * 2, start, true, true));
        assert!(pinger.pong(&ID).is_some());
        // Answered: the next is a period after the last, not at once.
        assert!(!pinger.due(at + EVERY - MS, at + EVERY - MS, false, false));
        assert!(pinger.due(at + EVERY, at + EVERY, false, false));
        assert!(pinger.pong(&ID).is_none(), "an answer counted twice");
    }

    #[test]
    fn a_link_is_dead_only_when_the_ping_and_the_silence_both_reach_the_limit() {
        let (mut pinger, start) = timer();
        // No ping waits: never dead, however long the silence.
        assert!(!pinger.dead(start, start + LIMIT * 10));
        let at = start + EVERY;
        pinger.sent(ID, at);
        assert!(!pinger.dead(start, at + LIMIT - MS), "before the limit");
        assert!(pinger.dead(start, at + LIMIT), "at the limit");
        // Something arrived 1 ms after the ping: alive until that is old too.
        let heard = at + MS;
        assert!(!pinger.dead(heard, at + LIMIT));
        assert!(pinger.dead(heard, heard + LIMIT));
        // The silence alone is not enough: the ping must have waited.
        let mut late = timer().0;
        late.sent(ID, at + LIMIT);
        assert!(!late.dead(start, at + LIMIT + MS));
        // Answered: not dead.
        assert!(pinger.pong(&ID).is_some());
        assert!(!pinger.dead(start, at + LIMIT * 2));
    }

    #[test]
    fn the_worker_wakes_for_the_next_ping_or_for_the_verdict() {
        let (mut pinger, start) = timer();
        // `start` is the timer's own start rounded up to a millisecond.
        let next = pinger.wake_at(start);
        assert!(next <= start + EVERY && next + MS > start + EVERY);
        let at = start + EVERY;
        pinger.sent(ID, at);
        // The verdict: the limit after the ping, or after what was heard
        // since, whichever is later.
        assert_eq!(pinger.wake_at(start), at + LIMIT);
        assert_eq!(pinger.wake_at(at + MS * 30), at + MS * 30 + LIMIT);
    }
}

/// One probe is one ping: the request is taken down when it is served, so
/// the worker does not go on pinging as fast as the answers come.
#[test]
fn one_probe_sends_one_ping_and_leaves_the_worker_asleep() {
    let (count_tx, count_rx) = crossbeam_channel::unbounded();
    let (client, peer) = with_limits(60_000, 5_000, || {
        peer(None, move |socket| {
            socket
                .get_mut()
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            while let Ok(message) = socket.read() {
                if let Message::Ping(_) = message {
                    let _ = count_tx.send(());
                }
            }
        })
    });
    thread::sleep(Duration::from_millis(100));
    client.probe();
    thread::sleep(Duration::from_millis(400));
    let wakes = client.wakes();
    thread::sleep(Duration::from_millis(400));
    assert_eq!(count_rx.try_iter().count(), 1, "one probe, one ping");
    let woke = client.wakes() - wakes;
    assert!(woke <= 2, "the worker woke {woke} times after its probe");
    drop(client);
    peer.join().unwrap();
}
