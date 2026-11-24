#![allow(clippy::unwrap_used)]
//! Card #876, live: on a quiet, healthy link Home and the open session's
//! sidebar keep one catalog connection and show no reconnect. A harness owns a
//! private daemon and tmux server (and, for SSH, a private sshd) and counts the
//! daemon's requests; this half is the app without a window. It prints one
//! `CHURN` line per change of what the window would show, and a summary per
//! phase: Home idle for `TMUX_IDE_CHURN_HOME_S`, then the first session open
//! for `TMUX_IDE_CHURN_SESSION_S`. `TMUX_IDE_CHURN_SSH_TARGET` runs it as
//! `--tmux-native-ssh TARGET` starts the app. `TMUX_IDE_CHURN_BLUR_EVERY_S`
//! sends the window to the background for 3 s that often, as switching to
//! another app does.
use super::*;

fn seconds(name: &str, default: u64) -> Duration {
    Duration::from_secs(
        std::env::var(name)
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(default),
    )
}
fn epoch_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis()
}
fn agents(phase: &home_agents::Phase) -> &'static str {
    match phase {
        home_agents::Phase::Loading => "loading",
        home_agents::Phase::Live => "live",
        home_agents::Phase::Partial => "partial",
        home_agents::Phase::Unavailable => "unavailable",
    }
}
/// What the window shows that a reconnect would change.
fn shown(s: &State) -> serde_json::Value {
    serde_json::json!({
        "surface": if s.surface == Surface::Home { "home" } else { "workspace" },
        "phase": format!("{:?}", s.home_phase),
        "status": s.status,
        "attempt": s.reconnect_attempt,
        "held": s.retained_preview,
        "probe": s.link_probe,
        "agentsLastKnown": s.agents_last_known,
        "homeAgents": s.home_agents.as_ref().map(|r| agents(&r.phase)),
        "sessionAgents": s.workspace_agents.as_ref().map(|r| agents(&r.roster.phase)),
        "sessions": s.sessions.len(),
        "complete": s.session_catalog_complete,
        "fault": s.home_fault,
    })
}

#[test]
#[ignore = "requires a churn harness with a private daemon"]
fn sidebar_and_home_hold_one_connection_on_a_quiet_link() {
    let (bridge, owner) = match std::env::var("TMUX_IDE_CHURN_SSH_TARGET") {
        Ok(target) if !target.is_empty() => start_remote(
            herdr_client::tmux_ssh::SshTarget::parse(&target).unwrap(),
            None,
            None,
            Default::default(),
        )
        .unwrap(),
        _ => start(
            std::env::var_os("TMUX_IDE_TEST_DAEMON_RECORD").unwrap().into(),
            Default::default(),
        )
        .unwrap(),
    };
    bridge
        .commands
        .send(Command::Presence {
            active: true,
            revision: 1,
        })
        .unwrap();
    let take = || {
        bridge
            .mailbox
            .lock()
            .unwrap()
            .take()
            .map(|state| state.unwrap_or_else(|| panic!("native browser closed")))
    };
    let started = Instant::now();
    let home = loop {
        assert!(started.elapsed() < Duration::from_secs(60), "Home never loaded");
        if let Some(s) = take()
            && s.home_phase == HomePhase::Live
            && s.session_catalog_complete
            && !s.sessions.is_empty()
        {
            break s;
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    let blur_every = std::env::var("TMUX_IDE_CHURN_BLUR_EVERY_S")
        .ok()
        .and_then(|v| v.parse().ok())
        .map(Duration::from_secs);
    let mut presence = 1u64;
    let mut blurred: Option<Instant> = None;
    let mut next_blur = blur_every.map(|every| Instant::now() + every);
    let mut last = shown(&home);
    let mut request = home.request;
    let session = home.sessions[0].id.clone();
    for (phase, length) in [
        ("home", seconds("TMUX_IDE_CHURN_HOME_S", 600)),
        ("session", seconds("TMUX_IDE_CHURN_SESSION_S", 600)),
    ] {
        if phase == "session" {
            request += 1;
            bridge
                .commands
                .send(Command::Session {
                    request,
                    id: session.clone(),
                })
                .unwrap();
            let opened = Instant::now();
            loop {
                assert!(opened.elapsed() < Duration::from_secs(60), "the session never opened");
                if let Some(s) = take()
                    && s.request == request
                    && s.surface == Surface::Workspace
                    && s.input_ready
                {
                    last = shown(&s);
                    break;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        eprintln!("CHURN_PHASE {{\"phase\":\"{phase}\",\"at\":{}}}", epoch_ms());
        let (mut publications, mut changes, mut reconnects) = (0u64, 0u64, 0u64);
        let end = Instant::now() + length;
        while Instant::now() < end {
            if let Some(at) = next_blur
                && Instant::now() >= at
            {
                presence += 1;
                bridge
                    .commands
                    .send(Command::Presence {
                        active: false,
                        revision: presence,
                    })
                    .unwrap();
                eprintln!("CHURN_BLUR {}", epoch_ms());
                blurred = Some(Instant::now());
                next_blur = blur_every.map(|every| Instant::now() + every);
            }
            if blurred.is_some_and(|at| at.elapsed() >= Duration::from_secs(3)) {
                presence += 1;
                bridge
                    .commands
                    .send(Command::Presence {
                        active: true,
                        revision: presence,
                    })
                    .unwrap();
                blurred = None;
            }
            let Some(s) = take() else {
                std::thread::sleep(Duration::from_millis(5));
                continue;
            };
            publications += 1;
            let now = shown(&s);
            if now != last {
                changes += 1;
                let reconnecting = s.reconnect_attempt.is_some()
                    || s.status.contains("econnect")
                    || s.agents_last_known
                    || s.retained_preview;
                reconnects += u64::from(reconnecting);
                eprintln!(
                    "CHURN {}",
                    serde_json::json!({"phase": phase, "at": epoch_ms(), "shown": now})
                );
                last = now;
            }
        }
        eprintln!(
            "CHURN_SUMMARY {}",
            serde_json::json!({"phase": phase, "seconds": length.as_secs(),
                "publications": publications, "changes": changes, "reconnecting": reconnects})
        );
    }
    owner.shutdown().unwrap();
}
