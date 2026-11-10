#![allow(clippy::unwrap_used)]
use super::*;
use crate::tmux_snapshot::fit_test_support::fixture_view;
use core::prelude::v1::test;
use std::{cell::Cell, sync::mpsc};

const S: fn(u64) -> Duration = Duration::from_millis;

#[test]
fn thresholds_follow_the_owner_approved_steps() {
    use {Kind::*, Stage::*};
    for (kind, ms, want) in [
        (Session, 1_500, Quiet),
        (Session, 1_999, Quiet),
        (Session, 2_000, Spinner),
        (Session, 3_000, Spinner),
        (Session, 8_000, Words),
        (Session, 9_000, Words),
        (Session, 60_000, Offline),
        (Home, 61_000, Words),
        (Startup, 500, Quiet),
        (Startup, 1_000, Spinner),
        (Startup, 8_000, Words),
        (Startup, 120_000, Words),
    ] {
        assert_eq!(stage(kind, S(ms), false), want, "{kind:?} at {ms} ms");
    }
    // A refused key goes straight to the words, and never backwards.
    assert_eq!(stage(Session, S(100), true), Words);
    assert_eq!(stage(Session, S(61_000), true), Offline);
}

#[test]
fn only_a_live_bridge_waits_and_each_wait_has_its_kind() {
    let state = |reconnect: Option<u32>, surface, phase| browser::State {
        reconnect_attempt: reconnect,
        surface,
        home_phase: phase,
        ..Default::default()
    };
    use browser::{HomePhase as P, Surface as F};
    assert_eq!(
        waiting(&state(Some(1), F::Workspace, P::Live), true),
        Some(Kind::Session)
    );
    assert_eq!(
        waiting(&state(Some(1), F::Home, P::Live), true),
        Some(Kind::Home)
    );
    assert_eq!(
        waiting(&state(None, F::Home, P::Loading), true),
        Some(Kind::Startup)
    );
    assert_eq!(waiting(&state(None, F::Home, P::Live), true), None);
    // The bridge gone is not a wait: only reopening helps.
    assert_eq!(waiting(&state(Some(1), F::Workspace, P::Live), false), None);
    // A setup step is the user's: it shows as soon as it is known.
    let mut setup = state(None, F::Home, P::Loading);
    setup.local_setup = Some(browser::local_setup::Setup {
        phase: browser::local_setup::Phase::Failed,
    });
    assert_eq!(waiting(&setup, true), None);
}

#[test]
fn the_not_sent_toast_reads_over_a_white_and_a_black_desktop() {
    for theme in [
        bezel_theme::Theme::for_appearance(bezel_theme::Appearance::Light),
        bezel_theme::Theme::for_appearance(bezel_theme::Appearance::Dark),
    ] {
        let ink = toast_ink(&theme);
        for desktop in [0xffffff, 0x000000] {
            let plate = glass_over(&theme, desktop);
            let ratio = bezel_theme::contrast_ratio(ink, plate);
            assert!(ratio >= 4.5, "{ratio} over {desktop:06x}");
        }
    }
}

/// A clock the test moves by hand.
fn clock() -> (Clock, Rc<Cell<Duration>>) {
    let start = Instant::now();
    let wall = SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000);
    let offset = Rc::new(Cell::new(Duration::ZERO));
    let read = offset.clone();
    (
        Rc::new(move || (start + read.get(), wall + read.get())),
        offset,
    )
}

fn session_drop() -> browser::State {
    browser::State {
        surface: browser::Surface::Workspace,
        request: 7,
        input_ready: true,
        status: "Connected".into(),
        panes: vec![
            serde_json::from_value(serde_json::json!({
                "id": "pane-a", "label": "editor", "windowId": "window-1", "paneCount": null,
                "windowLabel": "editor"
            }))
            .unwrap(),
        ],
        ..Default::default()
    }
}

/// Bounds of the chrome that must stay put while the connection comes and goes.
const STILL: [&str; 4] = [
    "tmux-sidebar-footer-left",
    "tmux-sidebar-footer-right",
    "tmux-connection-slot",
    "tmux-workspace-inset",
];

fn bounds(cx: &mut VisualTestContext) -> Vec<Option<Bounds<Pixels>>> {
    STILL.iter().map(|s| cx.debug_bounds(s)).collect()
}

#[gpui::test]
fn a_short_drop_changes_nothing_and_a_long_one_only_the_slot_and_titles(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (view, cx) =
        cx.add_window_view(|window, cx| fixture_view(window, cx, sender, 7, session_drop()));
    let (clock, at) = clock();
    view.update(cx, |view, _| view.connection.clock = clock);
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let before = bounds(cx);
    // The stream drops.
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.browser_state.reconnect_attempt = Some(1);
            view.browser_state.status = "Connection lost. Reconnecting…".into();
            view.observe_connection(cx);
        });
        window.draw(cx).clear(cx);
    });
    cx.update(|_, cx| cx.set_global(crate::tmux_snapshot::design::InkProbes::default()));
    let title_ink = |cx: &mut VisualTestContext| {
        cx.update(|_, cx| {
            cx.global::<crate::tmux_snapshot::design::InkProbes>()
                .0
                .get("pane-title:pane-a")
                .copied()
        })
    };
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let focused_ink = title_ink(cx).unwrap();
    for (ms, want, muted) in [
        (1_500, Stage::Quiet, false),
        (3_000, Stage::Spinner, false),
        (9_000, Stage::Words, true),
    ] {
        at.set(S(ms));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        assert_eq!(
            title_ink(cx) != Some(focused_ink),
            muted,
            "{ms} ms: title ink"
        );
        view.read_with(cx, |view, _| {
            assert_eq!(view.connection_stage(), want, "{ms} ms");
            assert_eq!(view.connection_mutes_titles(), muted, "{ms} ms");
            // No notice beside the tabs: the status line is empty and routine.
            assert_eq!(view.status_line(), "");
            assert!(!crate::tmux_snapshot::status_presentation::visible(
                &view.status_line(),
                false,
                true
            ));
        });
        assert_eq!(bounds(cx), before, "{ms} ms: chrome moved");
        assert!(cx.debug_bounds("tmux-reconnect-retry").is_none());
        assert!(cx.debug_bounds("tmux-connection-retry").is_none());
    }
    // Past a minute the slot is the one way to retry now.
    at.set(S(61_000));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert!(cx.debug_bounds("tmux-connection-retry").is_some());
    assert_eq!(bounds(cx), before);
}

#[gpui::test]
fn the_offline_slot_retries_the_request_it_was_drawn_for(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let mut state = session_drop();
    state.reconnect_attempt = Some(9);
    let (view, cx) = cx.add_window_view(|window, cx| fixture_view(window, cx, sender, 7, state));
    let (clock, at) = clock();
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.connection.clock = clock;
            view.observe_connection(cx);
        })
    });
    at.set(S(61_000));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    while receiver.try_recv().is_ok() {}
    let retry = cx.debug_bounds("tmux-connection-retry").unwrap();
    cx.simulate_click(retry.center(), Modifiers::none());
    let sent: Vec<_> = receiver.try_iter().collect();
    assert!(
        sent.iter().any(|c| serde_json::to_value(c).unwrap()
            == serde_json::json!({"type":"retry-reconnect","request":7})),
        "{:?}",
        sent.iter()
            .map(|c| serde_json::to_value(c).unwrap())
            .collect::<Vec<_>>()
    );
}

#[gpui::test]
fn a_refused_key_shows_not_sent_at_once_and_nothing_is_sent_later(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let mut state = session_drop();
    state.reconnect_attempt = Some(1);
    state.retained_preview = true;
    let (view, cx) = cx.add_window_view(|window, cx| fixture_view(window, cx, sender, 7, state));
    let (clock, at) = clock();
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.connection.clock = clock;
            view.observe_connection(cx);
        })
    });
    at.set(S(100));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert!(cx.debug_bounds("tmux-not-sent").is_none());
    while receiver.try_recv().is_ok() {}
    cx.update(|_, cx| {
        view.update(cx, |view, cx| assert!(!view.offer_terminal_input(cx)));
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    // The next frame: the toast in the pane, the slot at its words.
    assert!(cx.debug_bounds("tmux-not-sent").is_some());
    view.read_with(cx, |view, _| {
        assert_eq!(view.connection_stage(), Stage::Words);
    });
    // The stream is back: the toast goes, and nothing typed is replayed.
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.browser_state.reconnect_attempt = None;
            view.browser_state.retained_preview = false;
            view.observe_connection(cx);
        });
        window.draw(cx).clear(cx);
    });
    assert!(cx.debug_bounds("tmux-not-sent").is_none());
    let replayed: Vec<_> = receiver
        .try_iter()
        .map(|c| serde_json::to_value(c).unwrap())
        .filter(|c| c["type"] == "input" && c["input"]["kind"] != "resize")
        .collect();
    assert!(replayed.is_empty(), "{replayed:?}");
}

#[gpui::test]
fn with_the_sidebar_hidden_the_slot_floats_only_while_it_shows(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let mut state = session_drop();
    state.reconnect_attempt = Some(1);
    let (view, cx) = cx.add_window_view(|window, cx| fixture_view(window, cx, sender, 7, state));
    let (clock, at) = clock();
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.sidebar_hidden = true;
            view.connection.clock = clock;
            view.observe_connection(cx);
        })
    });
    at.set(S(1_000));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert!(cx.debug_bounds("tmux-connection-float").is_none());
    at.set(S(9_000));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert!(cx.debug_bounds("tmux-connection-float").is_some());
    assert!(cx.debug_bounds("tmux-sidebar-footer-left").is_none());
}

#[test]
fn the_spinner_turns_only_without_reduce_motion() {
    assert!(animates(true, false));
    assert!(!animates(true, true));
    assert!(!animates(false, false));
}

#[gpui::test]
fn reduce_motion_shows_a_still_spinner(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let mut state = session_drop();
    state.reconnect_attempt = Some(1);
    let (view, cx) = cx.add_window_view(|window, cx| fixture_view(window, cx, sender, 7, state));
    let (clock, at) = clock();
    cx.update(|_, cx| {
        cx.set_reduce_motion(true);
        view.update(cx, |view, cx| {
            view.connection.clock = clock;
            view.observe_connection(cx);
        })
    });
    at.set(S(3_000));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    view.read_with(cx, |view, cx| {
        assert_eq!(view.connection_stage(), Stage::Spinner);
        assert!(cx.reduce_motion());
        // No slot reserved for the animated overlay: the frame stands still.
        assert!(view.agent_animation.slot_bounds().is_empty());
    });
}

#[gpui::test]
fn startup_paints_no_loading_text(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let state = browser::State {
        surface: browser::Surface::Home,
        request: 7,
        ..crate::tmux_snapshot::home::initial_state()
    };
    let (view, cx) = cx.add_window_view(|window, cx| fixture_view(window, cx, sender, 7, state));
    let (clock, at) = clock();
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.connection.clock = clock;
            view.observe_connection(cx);
        })
    });
    for ms in [0, 500, 1_500, 9_000] {
        at.set(S(ms));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        assert!(cx.debug_bounds("home-status-subtitle").is_none(), "{ms} ms");
        assert!(cx.debug_bounds("home-empty").is_none(), "{ms} ms");
    }
    view.read_with(cx, |view, _| {
        assert_eq!(view.connection_stage(), Stage::Words)
    });
}

#[gpui::test]
fn keys_in_flight_at_the_drop_get_the_same_toast(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (view, cx) =
        cx.add_window_view(|window, cx| fixture_view(window, cx, sender, 7, session_drop()));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let mut dropped = view.browser_state.clone();
            dropped.reconnect_attempt = Some(1);
            dropped.retained_preview = true;
            // The worker reports that the keys it held were not delivered.
            dropped.input_target_rejected = true;
            view.apply_browser_state(Some(dropped), cx);
        });
        window.draw(cx).clear(cx);
    });
    assert!(cx.debug_bounds("tmux-not-sent").is_some());
    view.read_with(cx, |view, _| {
        assert_eq!(view.connection_stage(), Stage::Words)
    });
}

#[gpui::test]
fn what_only_the_user_can_act_on_stays_loud(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (view, cx) =
        cx.add_window_view(|window, cx| fixture_view(window, cx, sender, 7, session_drop()));
    // An action interrupted by the drop: its outcome is unknown, and that is
    // not a reconnect, so it shows beside the tabs as before.
    view.update(cx, |view, _| {
        view.browser_state.status =
            "Connection lost during an action — refresh to inspect its outcome".into();
    });
    view.read_with(cx, |view, _| {
        let line = view.status_line();
        assert!(line.contains("outcome"));
        assert!(crate::tmux_snapshot::status_presentation::visible(
            &line, false, true
        ));
    });
    // A pane that ended keeps its notice in its title while reconnecting.
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.browser_state.unavailable_panes = vec!["pane-a".into()];
            view.browser_state.reconnect_attempt = Some(1);
            view.observe_connection(cx);
        })
    });
    view.read_with(cx, |view, _| {
        assert!(
            crate::tmux_snapshot::pane_chrome::label(&view.browser_state, "pane-a")
                .ends_with(crate::tmux_snapshot::pane_chrome::UNAVAILABLE)
        );
    });
}

/// r3: each state only the user can fix gives one card and its slot label.
#[test]
fn each_act_needed_state_has_its_card_and_slot_label() {
    let with_act = |act| browser::State {
        act: Some(act),
        status: "reason".into(),
        ..Default::default()
    };
    for (act, slot) in [
        (Act::DaemonUpdate, UPDATE_NEEDED),
        (Act::Record, SETUP_NEEDED),
        (Act::Credentials, SETUP_NEEDED),
        (Act::Platform, SETUP_NEEDED),
        (Act::Unreadable, SETUP_NEEDED),
        (Act::GaveUp, COULDNT_RECONNECT),
        (Act::SshIdentity, SETUP_NEEDED),
        (Act::AppUpdate, UPDATE_NEEDED),
    ] {
        let card = card(&with_act(act), true).unwrap();
        assert_eq!(card.slot, slot, "{act:?}");
        if act != Act::Credentials {
            assert_eq!(card.detail, "reason");
        }
        assert!(card.retry.is_none());
    }
    use browser::local_setup::{Phase, Setup};
    for (phase, slot) in [
        (Phase::Available, Some(SETUP_NEEDED)),
        (Phase::Missing, Some(SETUP_NEEDED)),
        (Phase::Unsupported, Some(UPDATE_NEEDED)),
        (Phase::Unrecognized, Some(SETUP_NEEDED)),
        (Phase::Failed, Some(SETUP_NEEDED)),
        (Phase::StoppedWaiting, Some(SETUP_NEEDED)),
        (Phase::Running, None),
    ] {
        let state = browser::State {
            local_setup: Some(Setup { phase }),
            ..Default::default()
        };
        assert_eq!(card(&state, true).map(|c| c.slot), slot);
        assert_eq!(
            card(&state, true).and_then(|c| c.action),
            slot.map(|_| phase.label())
        );
    }
    // Nothing to act on: no card.
    assert_eq!(card(&browser::State::default(), true), None);
}

#[test]
fn a_remote_machine_only_the_user_can_fix_gets_the_card_with_its_retry() {
    let fleet = |failure: &str| -> browser::fleet::Fleet {
        serde_json::from_value(serde_json::json!({
            "groups": [{"id": "spark", "label": "spark", "state": "disconnected",
                "conflict": false, "omittedSessions": 0, "sessions": [],
                "retry": "22222222-2222-4222-8222-222222222222",
                "diagnostic": {"phase": "needs-attention", "failure": failure}}],
            "omittedGroups": 0,
            "preferences": {"revision": 1, "phase": "ready", "error": null}
        }))
        .unwrap()
    };
    for (failure, slot) in [
        ("ssh-authentication", Some(SETUP_NEEDED)),
        ("ssh-host-key", Some(SETUP_NEEDED)),
        ("remote-cli-missing", Some(SETUP_NEEDED)),
        ("daemon-missing", Some(SETUP_NEEDED)),
        ("incompatible", Some(UPDATE_NEEDED)),
        // Unreachable is retried by itself (r4): no card.
        ("unavailable", None),
    ] {
        let state = browser::State {
            fleet: Some(fleet(failure)),
            ..Default::default()
        };
        let card = card(&state, true);
        assert_eq!(card.as_ref().map(|c| c.slot), slot, "{failure}");
        if let Some(card) = card {
            assert_eq!(card.title, "spark needs you");
            assert!(card.retry.is_some());
        }
    }
}

#[gpui::test]
fn the_slot_says_so_at_once_and_home_shows_the_card(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let state = browser::State {
        surface: browser::Surface::Home,
        home_phase: browser::HomePhase::Unavailable,
        request: 7,
        act: Some(Act::DaemonUpdate),
        status: "This daemon needs an update. Update tmux-ide, then refresh.".into(),
        ..Default::default()
    };
    let (view, cx) = cx.add_window_view(|window, cx| fixture_view(window, cx, sender, 7, state));
    let (clock, _at) = clock();
    view.update(cx, |view, _| view.connection.clock = clock);
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert!(cx.debug_bounds("tmux-connection-act").is_some());
    assert!(cx.debug_bounds("home-act-card").is_some());
    assert!(cx.debug_bounds("home-act-action").is_some());
    assert!(cx.debug_bounds("home-act-copy").is_some());
    assert!(cx.debug_bounds("home-status-warning").is_none());
}

/// #357 review, item 2: the wait starts when the window does. A worker that
/// never publishes still brings the spinner at 1 s and the words at 8 s.
#[gpui::test]
fn a_worker_that_never_publishes_still_reaches_the_spinner_and_words(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let state = browser::State {
        surface: browser::Surface::Home,
        request: 7,
        ..crate::tmux_snapshot::home::initial_state()
    };
    let (view, cx) = cx.add_window_view(|window, cx| fixture_view(window, cx, sender, 7, state));
    let (clock, at) = clock();
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.connection.clock = clock;
            // What window creation does; no publication follows.
            view.observe_connection(cx);
        })
    });
    for (ms, stage) in [
        (500, Stage::Quiet),
        (2_000, Stage::Spinner),
        (8_000, Stage::Words),
    ] {
        at.set(S(ms));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        view.read_with(cx, |view, _| {
            assert_eq!(view.connection_stage(), stage, "{ms} ms")
        });
    }
}

/// #357 review, item 3: "Connecting…" until a connection has existed, then
/// "Reconnecting…".
#[gpui::test]
fn first_connection_says_connecting_and_later_drops_say_reconnecting(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let state = browser::State {
        surface: browser::Surface::Home,
        request: 7,
        ..crate::tmux_snapshot::home::initial_state()
    };
    let (view, cx) = cx.add_window_view(|window, cx| fixture_view(window, cx, sender, 7, state));
    let (clock, at) = clock();
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.connection.clock = clock;
            view.observe_connection(cx);
        })
    });
    at.set(S(9_000));
    view.read_with(cx, |view, _| {
        assert_eq!(view.connection_words(), CONNECTING)
    });
    // Connected: Home is live. Then a refresh reloads, and later a drop.
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.browser_state.home_phase = browser::HomePhase::Live;
            view.observe_connection(cx);
            view.browser_state.home_phase = browser::HomePhase::Loading;
            view.observe_connection(cx);
        })
    });
    view.read_with(cx, |view, _| {
        assert_eq!(view.connection_words(), RECONNECTING)
    });
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.browser_state.home_phase = browser::HomePhase::Live;
            view.browser_state.reconnect_attempt = Some(1);
            view.observe_connection(cx);
        })
    });
    view.read_with(cx, |view, _| {
        assert_eq!(view.connection_words(), RECONNECTING)
    });
}

/// #357 review, item 4: a selected captured frame says why keys do nothing,
/// beside the tabs as before, also during a reconnect.
#[gpui::test]
fn the_selection_hint_stays_during_a_reconnect(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let mut state = session_drop();
    state.reconnect_attempt = Some(1);
    let (view, cx) = cx.add_window_view(|window, cx| fixture_view(window, cx, sender, 7, state));
    view.read_with(cx, |view, _| assert_eq!(view.status_line(), ""));
    view.update(cx, |view, _| {
        let frame = view.browser_state.frame.clone().unwrap();
        let (width, height) = (frame.view().width(), frame.view().height());
        let mut at = view.browser_state.clone();
        at.reconnect_attempt = None;
        at.selected_pane = Some("pane".into());
        at.copy_region = Some(crate::tmux_snapshot::copy::Region {
            id: "pane".into(),
            left: 0,
            top: 0,
            width,
            height,
            wrapped: vec![false; usize::from(height)],
        });
        view.selection = crate::tmux_snapshot::selection::Capture::begin(&at, 0., 0.);
        assert!(view.selection.is_some());
    });
    view.read_with(cx, |view, _| {
        let line = view.status_line();
        assert_eq!(line, crate::tmux_snapshot::status_presentation::SELECTING);
        assert!(crate::tmux_snapshot::status_presentation::visible(
            &line, false, true
        ));
    });
}

/// #360 review (c): the credentials card says what its button does, and that
/// button (Refresh) reads the daemon's record and credentials again. An app
/// too old for its daemon gets no button at all: nothing in the app fixes it.
#[test]
fn each_cards_text_and_action_agree() {
    let state = |act| browser::State {
        act: Some(act),
        status: "reason".into(),
        ..Default::default()
    };
    let credentials = card(&state(Act::Credentials), true).unwrap();
    assert_eq!(credentials.action, Some("Refresh"));
    assert!(credentials.detail.contains("Refresh reads them again"));
    assert!(!credentials.detail.contains("Restart tmux-ide."));
    assert_eq!(card(&state(Act::AppUpdate), true).unwrap().action, None);
    assert_eq!(
        card(&state(Act::GaveUp), true).unwrap().action,
        Some("Refresh sessions")
    );
}

/// #360 review (a): the pane-limit notice stays loud beside an act card.
#[gpui::test]
fn the_pane_limit_notice_shows_beside_an_act_card(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let state = browser::State {
        surface: browser::Surface::Home,
        home_phase: browser::HomePhase::Live,
        request: 7,
        home_notice: Some("This session has 38 panes; tmux-ide opens at most 24.".into()),
        fleet: Some(
            serde_json::from_value(serde_json::json!({
                "groups": [{"id": "spark", "label": "spark", "state": "disconnected",
                    "conflict": false, "omittedSessions": 0, "sessions": [],
                    "retry": "22222222-2222-4222-8222-222222222222",
                    "diagnostic": {"phase": "needs-attention", "failure": "ssh-authentication"}}],
                "omittedGroups": 0,
                "preferences": {"revision": 1, "phase": "ready", "error": null}
            }))
            .unwrap(),
        ),
        ..Default::default()
    };
    let (view, cx) = cx.add_window_view(|window, cx| fixture_view(window, cx, sender, 7, state));
    let (clock, _at) = clock();
    view.update(cx, |view, _| view.connection.clock = clock);
    cx.simulate_resize(size(px(1200.), px(900.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert!(cx.debug_bounds("home-act-card").is_some());
    assert!(cx.debug_bounds("home-status-warning").is_some());
}
