//! The welcome (onboarding A1) and What's new (A5).
#![allow(clippy::unwrap_used)]
use super::*;
use crate::tmux_snapshot::connection::jargon;
use browser::local_setup::Setup;
use core::prelude::v1::test;
use std::sync::mpsc;

fn choice(id: &str, label: &str) -> browser::Choice {
    browser::Choice {
        id: id.into(),
        label: label.into(),
        pane_count: Some(2),
        window_id: None,
        browser_icon: None,
        display_name_source: None,
        window_label: None,
        largest_window: None,
    }
}

/// Home, live, with `sessions`; setup at `phase` when given.
pub(super) fn home<'a>(
    cx: &'a mut TestAppContext,
    phase: Option<Phase>,
    sessions: &[(&str, &str)],
    welcome: State,
) -> (
    Entity<SnapshotView>,
    &'a mut VisualTestContext,
    mpsc::Receiver<browser::Command>,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let sessions: Vec<_> = sessions.iter().map(|(id, l)| choice(id, l)).collect();
    let (view, cx) = cx.add_window_view(move |window, cx| {
        let mut view = crate::tmux_snapshot::fit_test_support::fixture_view(
            window,
            cx,
            sender,
            7,
            browser::State {
                request: 7,
                surface: browser::Surface::Home,
                home_phase: if phase.is_some() {
                    browser::HomePhase::Unavailable
                } else {
                    browser::HomePhase::Live
                },
                input_ready: true,
                sessions,
                local_setup: phase.map(|phase| Setup { phase }),
                ..Default::default()
            },
        );
        view.welcome = welcome;
        view
    });
    cx.simulate_resize(size(px(1200.), px(900.)));
    draw(cx);
    receiver.try_iter().for_each(drop);
    (view, cx, receiver)
}
pub(super) fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| window.draw(cx).clear(cx));
}
pub(super) fn shown(cx: &mut VisualTestContext) -> bool {
    draw(cx);
    cx.debug_bounds("welcome").is_some()
}
pub(super) fn fresh(dir: &tempfile::TempDir) -> State {
    State::for_test(
        Some(dir.path().join("gpui-onboarding.json")),
        Some("0.1.17"),
    )
}
fn saved(dir: &tempfile::TempDir, cx: &mut VisualTestContext) -> State {
    cx.run_until_parked();
    fresh(dir)
}
pub(super) fn publish(
    view: &Entity<SnapshotView>,
    cx: &mut VisualTestContext,
    phase: Option<Phase>,
) {
    cx.update(|_, cx| {
        view.update(cx, |v, cx| {
            v.browser_state.local_setup = phase.map(|phase| Setup { phase });
            v.browser_state.home_phase = if phase.is_some() {
                browser::HomePhase::Unavailable
            } else {
                browser::HomePhase::Live
            };
            cx.notify();
        })
    });
    draw(cx);
}

#[test]
fn the_guide_shows_to_someone_new_and_never_again_by_itself() {
    use Decision::*;
    use Found::*;
    let available = Some(Phase::Available);
    // (ready, found, welcomed, connected, setup, live) → decision
    for (ready, found, welcomed, connected, setup, live, expected) in [
        (false, Missing, false, true, available, false, Wait),
        // Never had the file: shown, whatever the service is doing, even
        // before Home answers.
        (true, Missing, false, true, None, true, Show),
        (true, Missing, false, true, available, false, Show),
        (true, Missing, false, false, None, false, Show),
        // A file that says welcomed (every 0.1.17+ user): never.
        (true, Saved, true, true, available, false, Welcomed),
        (true, Saved, true, true, None, true, Welcomed),
        // A file the guide wrote while it was open: shown again.
        (true, Saved, false, true, None, true, Show),
        // A file that can't be read keeps the old rule: only where setup
        // is needed, and an existing user with Home live is remembered.
        (true, Unreadable, false, true, None, true, AlreadySetUp),
        (true, Unreadable, false, true, available, false, Show),
        (true, Unreadable, false, true, available, true, Show),
        (true, Unreadable, false, false, available, false, Wait),
        (true, Unreadable, false, true, None, false, Wait),
    ] {
        assert_eq!(
            decide(ready, found, welcomed, connected, setup, live),
            expected,
            "{ready} {found:?} {welcomed} {connected} {setup:?} {live}"
        );
    }
}

#[test]
fn the_checklist_says_what_is_true_in_each_stage() {
    let titles = |stage, elapsed, stopped| -> Vec<(Mark, String, Option<String>, String)> {
        lines(stage, elapsed, stopped)
            .into_iter()
            .map(|l| (l.mark, l.title, l.detail, l.status))
            .collect()
    };
    let available = titles(Stage::Setup(Phase::Available), None, None);
    assert_eq!(
        available[0],
        (Mark::Done, CLI_TITLE.into(), None, "Installed".into())
    );
    assert_eq!(
        available[1],
        (
            Mark::Pending,
            SERVICE_TITLE.into(),
            Some(SERVICE_DETAIL.into()),
            "Not running".into()
        )
    );
    assert_eq!(
        available.len(),
        2,
        "no agents row until the app can find them"
    );
    let running = titles(
        Stage::Setup(Phase::Running),
        Some(Duration::from_millis(3400)),
        None,
    );
    assert_eq!(
        running[1],
        (
            Mark::Running,
            STARTING.into(),
            Some(STARTING_DETAIL.into()),
            "3 s".into()
        )
    );
    let timeout = titles(
        Stage::Setup(Phase::StoppedWaiting),
        None,
        Some(SETUP_DEADLINE),
    );
    assert_eq!(timeout[1].0, Mark::Problem);
    assert_eq!(timeout[1].1, FAILED_TITLE);
    assert_eq!(timeout[1].2.as_deref(), Some(FAILED_TIMEOUT));
    // Stopped early (the app left the foreground): no "20 seconds".
    let early = titles(
        Stage::Setup(Phase::StoppedWaiting),
        None,
        Some(Duration::from_secs(4)),
    );
    assert_eq!(early[1].2.as_deref(), Some(FAILED_EARLY));
    let unknown = titles(Stage::Setup(Phase::StoppedWaiting), None, None);
    assert_eq!(unknown[1].2.as_deref(), Some(FAILED_STOPPED));
    let failed = titles(Stage::Setup(Phase::Failed), None, None);
    assert_eq!(failed[1].2.as_deref(), Some(FAILED_OTHER));
    let missing = titles(Stage::Setup(Phase::Missing), None, None);
    assert_eq!(
        missing[0],
        (
            Mark::Problem,
            CLI_TITLE.into(),
            Some(MISSING.into()),
            "Not installed".into()
        )
    );
    assert_eq!(
        titles(Stage::Setup(Phase::Unsupported), None, None)[0]
            .2
            .as_deref(),
        Some(MISMATCH)
    );
    assert_eq!(
        titles(Stage::Setup(Phase::Unrecognized), None, None)[0]
            .2
            .as_deref(),
        Some(UNRECOGNIZED)
    );
    let ready = titles(Stage::Ready { sessions: 3 }, None, None);
    assert_eq!(ready[1].3, "Running");
    assert_eq!(
        ready[2],
        (
            Mark::Done,
            "You already have 3 tmux sessions".into(),
            None,
            "Ready".into()
        )
    );
    assert_eq!(already(1), "You already have 1 tmux session");
    assert_eq!(titles(Stage::Ready { sessions: 0 }, None, None).len(), 2);
}

#[test]
fn each_stage_offers_its_actions() {
    let acts = |stage| {
        let (secondary, primary) = buttons(stage).unwrap();
        (
            secondary.map(|b| (b.label, b.act)),
            (primary.label, primary.act, primary.enabled),
        )
    };
    assert_eq!(
        acts(Stage::Setup(Phase::Available)),
        (None, ("Set up Tmux IDE".into(), Act::SetUp, true))
    );
    assert!(!acts(Stage::Setup(Phase::Running)).1.2);
    for phase in [Phase::Failed, Phase::StoppedWaiting] {
        assert_eq!(
            acts(Stage::Setup(phase)),
            (
                Some(("Copy details".into(), Act::CopyDetails)),
                ("Try again".into(), Act::TryAgain, true)
            )
        );
    }
    assert_eq!(
        acts(Stage::Setup(Phase::Missing)),
        (
            Some(("Copy install command".into(), Act::CopyInstall)),
            ("I've installed it".into(), Act::InstalledIt, true)
        )
    );
    assert_eq!(acts(Stage::Setup(Phase::Unsupported)).1.1, Act::CopyUpdate);
    // Set up, or still checking: the guide's Continue is what comes next.
    assert_eq!(buttons(Stage::Ready { sessions: 3 }), None);
    assert_eq!(buttons(Stage::Ready { sessions: 0 }), None);
    assert_eq!(buttons(Stage::Waiting), None);
    // Where setup can't finish here, the guide offers to go on without it.
    for phase in [
        Phase::Failed,
        Phase::StoppedWaiting,
        Phase::Missing,
        Phase::Unsupported,
        Phase::Unrecognized,
    ] {
        assert!(setup_blocked(Stage::Setup(phase)), "{phase:?}");
    }
    for stage in [
        Stage::Setup(Phase::Available),
        Stage::Setup(Phase::Running),
        Stage::Ready { sessions: 0 },
        Stage::Waiting,
    ] {
        assert!(!setup_blocked(stage), "{stage:?}");
    }
}

#[test]
fn the_welcome_speaks_plainly() {
    let mut texts: Vec<String> = vec![
        TITLE.into(),
        READY_TITLE.into(),
        LEDE.into(),
        SKIP_HINT.into(),
        STUCK.into(),
        render::LOOK_TITLE.into(),
        render::LOOK_LEDE.into(),
        render::KEYS_TITLE.into(),
        render::KEYS_LEDE.into(),
        render::HINT.into(),
        render::START_USING.into(),
        guide_look::UNAVAILABLE.into(),
        guide_look::MATCH_NOTE.into(),
        guide_look::CURSOR_NOTE.into(),
        guide_look::OPAQUE_NOTE.into(),
        crate::tmux_snapshot::opaque_window::SAVE_FAILED.into(),
        "Continue without it".into(),
        "Skip setup".into(),
    ];
    for (label, _) in crate::tmux_snapshot::keymap::GUIDE {
        texts.push(label.to_string());
    }
    for stage in [
        Stage::Setup(Phase::Available),
        Stage::Setup(Phase::Running),
        Stage::Setup(Phase::Missing),
        Stage::Setup(Phase::Unsupported),
        Stage::Setup(Phase::Unrecognized),
        Stage::Setup(Phase::Failed),
        Stage::Setup(Phase::StoppedWaiting),
        Stage::Ready { sessions: 2 },
        Stage::Ready { sessions: 0 },
        Stage::Waiting,
    ] {
        for l in lines(stage, Some(SETUP_DEADLINE), Some(SETUP_DEADLINE)) {
            texts.extend([l.title, l.status]);
            texts.extend(l.detail);
        }
        if let Some((secondary, primary)) = buttons(stage) {
            texts.extend(secondary.map(|b| b.label));
            texts.push(primary.label);
        }
    }
    // Every user-facing line of What's new, every version and "Earlier".
    for (version, notes) in whats_new::RELEASES {
        texts.push(version.to_string());
        texts.extend(notes.iter().map(|n| n.to_string()));
    }
    texts.push(FAILED_STOPPED.into());
    for text in texts {
        assert_eq!(jargon(&text), None, "{text}");
    }
}

#[test]
fn what_is_remembered_survives_and_bad_files_start_over() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("gpui-onboarding.json");
    let missing = State::for_test(Some(path.clone()), None);
    assert!(missing.ready && !missing.welcomed && missing.whats_new_seen.is_none());
    assert_eq!(missing.found, Found::Missing);
    // Version 1, as 0.1.17 to 0.1.20 wrote it: read, the guide seen in
    // full when welcomed.
    std::fs::write(
        &path,
        r#"{"version":1,"welcomed":true,"whats_new_seen":"0.1.17"}"#,
    )?;
    let back = State::for_test(Some(path.clone()), None);
    assert!(back.welcomed);
    assert_eq!(back.found, Found::Saved);
    assert_eq!(back.whats_new_seen.as_deref(), Some("0.1.17"));
    assert_eq!(back.guide.reached, guide::ALL_REACHED);
    std::fs::write(&path, r#"{"version":1,"welcomed":false}"#)?;
    assert_eq!(State::for_test(Some(path.clone()), None).guide.reached, 0);
    // Written back, always as version 2, with the guide's progress.
    let mut state = State::for_test(Some(path.clone()), None);
    state.welcomed = true;
    state.guide.reached = 3;
    state.guide.setup_skipped = true;
    write(&path, &state.saved())?;
    let raw: serde_json::Value = serde_json::from_slice(&std::fs::read(&path)?)?;
    assert_eq!(raw["version"], 2);
    assert_eq!(
        raw["guide"],
        serde_json::json!({"reached": 3, "finished": false, "setup_skipped": true})
    );
    let again = State::for_test(Some(path.clone()), None);
    assert_eq!(again.guide.progress(), state.guide.progress());
    assert!(again.welcomed);
    for contents in [
        "not json",
        r#"{"version":3,"welcomed":true}"#,
        r#"{"version":2,"welcomed":true}"#,
        r#"{"version":1,"welcomed":true,"guide":{"reached":5,"finished":true,"setup_skipped":false}}"#,
        r#"{"version":2,"welcomed":true,"guide":{"reached":6,"finished":true,"setup_skipped":false}}"#,
        r#"{"version":2,"welcomed":true,"guide":{"reached":1,"finished":true,"setup_skipped":false,"x":1}}"#,
        r#"{"version":1,"welcomed":true,"extra":0}"#,
    ] {
        std::fs::write(&path, contents)?;
        let state = State::for_test(Some(path.clone()), None);
        assert!(state.ready && !state.welcomed, "{contents}");
        assert_eq!(state.found, Found::Unreadable, "{contents}");
    }
    Ok(())
}

#[gpui::test]
fn first_run_with_setup_needed_shows_the_welcome_in_homes_place(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (view, cx, _rx) = home(cx, Some(Phase::Available), &[], fresh(&dir));
    assert!(shown(cx));
    assert!(cx.debug_bounds("home-header").is_none());
    assert!(cx.debug_bounds("welcome-hero-0").is_some());
    assert!(cx.debug_bounds("welcome-rail").is_some());
    assert!(cx.debug_bounds("welcome-line-1").is_some());
    assert!(cx.debug_bounds("welcome-line-2").is_none(), "no agents row");
    // Not remembered until it closes.
    assert!(!saved(&dir, cx).welcomed);
    let _ = view;
}

/// Someone who ran 0.1.17 or later has the file: never shown by itself.
#[gpui::test]
fn an_existing_user_never_sees_it_but_commands_open_it(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("gpui-onboarding.json"),
        r#"{"version":1,"welcomed":true,"whats_new_seen":"0.1.17"}"#,
    )
    .unwrap();
    let (view, cx, _rx) = home(cx, None, &[("api", "api"), ("notes", "notes")], fresh(&dir));
    assert!(!shown(cx));
    assert!(cx.debug_bounds("home-header").is_some());
    // Commands → Welcome to Tmux IDE… opens it at Set up, ticked, with
    // Continue and every step open.
    cx.update(|window, cx| view.update(cx, |v, cx| v.open_welcome(window, cx)));
    assert!(shown(cx));
    assert!(cx.debug_bounds("welcome-next").is_some());
    assert!(
        cx.debug_bounds("welcome-session-0").is_none(),
        "sessions open from Keys"
    );
    view.read_with(cx, |v, _| {
        assert_eq!(v.welcome.guide.step, guide::Step::SetUp);
        for step in guide::Step::ALL {
            assert!(v.welcome.guide.enabled(step), "{step:?}");
        }
    });
}

/// Someone new whose installer already started the background service: the
/// guide shows, step one already ticked (0.1.20 never showed it).
#[gpui::test]
fn someone_new_with_the_service_running_sees_the_guide(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (view, cx, _rx) = home(cx, None, &[("api", "api")], fresh(&dir));
    assert!(shown(cx));
    let ticked = view.read_with(cx, |v, _| {
        lines(stage(&v.browser_state, true), None, None)
            .iter()
            .all(|l| l.mark == Mark::Done)
    });
    assert!(ticked, "everything ticked");
    assert!(cx.debug_bounds("welcome-next").is_some());
}

/// A damaged file never pushes the guide on an existing user.
#[gpui::test]
fn an_unreadable_file_with_home_live_is_an_existing_user(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("gpui-onboarding.json"), "not json").unwrap();
    let (_view, cx, _rx) = home(cx, None, &[("api", "api")], fresh(&dir));
    assert!(!shown(cx));
    cx.run_until_parked();
    let raw = std::fs::read_to_string(dir.path().join("gpui-onboarding.json")).unwrap();
    assert!(
        raw.contains(r#""welcomed":true"#),
        "remembered as welcomed: {raw}"
    );
}

#[gpui::test]
fn set_up_runs_the_managed_setup_and_shows_its_progress(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (view, cx, rx) = home(cx, Some(Phase::Available), &[], fresh(&dir));
    assert!(shown(cx));
    let primary = cx.debug_bounds("welcome-button-1").unwrap();
    cx.simulate_click(primary.center(), Modifiers::default());
    assert!(matches!(
        rx.try_recv().unwrap(),
        browser::Command::LocalSetup { .. }
    ));
    assert!(rx.try_recv().is_err());
    draw(cx);
    cx.executor().advance_clock(Duration::from_secs(3));
    draw(cx);
    let line = view.read_with(cx, |v, cx| {
        lines(stage(&v.browser_state, true), v.welcome_elapsed(cx), None)[1].clone()
    });
    assert_eq!(line.title, STARTING);
    assert_eq!(line.status, "3 s");
    // The worker succeeds: Home is live, the welcome says so and is
    // remembered, with this version's What's new already seen.
    publish(&view, cx, None);
    assert!(shown(cx));
    let state = saved(&dir, cx);
    assert!(state.welcomed);
    assert_eq!(state.whats_new_seen.as_deref(), Some("0.1.17"));
}

#[gpui::test]
fn a_setup_that_runs_out_says_so_and_can_be_tried_again(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (view, cx, rx) = home(cx, Some(Phase::Available), &[], fresh(&dir));
    assert!(shown(cx));
    cx.update(|window, cx| view.update(cx, |v, cx| v.welcome_act(Act::SetUp, window, cx)));
    assert!(matches!(
        rx.try_recv().unwrap(),
        browser::Command::LocalSetup { .. }
    ));
    draw(cx);
    cx.executor().advance_clock(SETUP_DEADLINE);
    publish(&view, cx, Some(Phase::StoppedWaiting));
    let (stage_now, stopped) = view.read_with(cx, |v, _| {
        (stage(&v.browser_state, true), v.welcome.stopped_after)
    });
    assert_eq!(stage_now, Stage::Setup(Phase::StoppedWaiting));
    let line = lines(stage_now, None, stopped)[1].clone();
    assert_eq!(line.mark, Mark::Problem);
    assert_eq!(line.detail.as_deref(), Some(FAILED_TIMEOUT));
    assert!(
        cx.debug_bounds("welcome-help").is_some(),
        "Still stuck? … get help"
    );
    assert!(
        cx.debug_bounds("welcome-button-0").is_some(),
        "Copy details"
    );
    // Try again runs it again.
    let again = cx.debug_bounds("welcome-button-1").unwrap();
    cx.simulate_click(again.center(), Modifiers::default());
    assert!(matches!(
        rx.try_recv().unwrap(),
        browser::Command::LocalSetup { .. }
    ));
    // A failure that isn't the deadline says nothing about 20 seconds.
    publish(&view, cx, Some(Phase::Failed));
    let line = view.read_with(cx, |v, _| {
        lines(stage(&v.browser_state, true), None, v.welcome.stopped_after)[1].clone()
    });
    assert_eq!(line.detail.as_deref(), Some(FAILED_OTHER));
    assert!(shown(cx), "a failure keeps the welcome");
    assert!(!saved(&dir, cx).welcomed);
}

#[gpui::test]
fn skip_closes_it_for_good(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (view, cx, rx) = home(cx, Some(Phase::Available), &[], fresh(&dir));
    assert!(shown(cx));
    let skip = cx.debug_bounds("welcome-skip").unwrap();
    cx.simulate_click(skip.center(), Modifiers::default());
    assert!(!shown(cx));
    assert!(cx.debug_bounds("home-header").is_some());
    assert!(rx.try_recv().is_err(), "skip runs nothing");
    let state = saved(&dir, cx);
    assert!(state.welcomed);
    // Next launch: setup still needed, but the welcome stays closed.
    cx.update(|_, cx| view.update(cx, |v, _| v.welcome = fresh(&dir)));
    assert!(!shown(cx));
}

#[gpui::test]
fn what_needs_the_user_stays_in_front_of_the_welcome(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (view, cx, _rx) = home(cx, Some(Phase::Available), &[], fresh(&dir));
    assert!(shown(cx));
    // Setup's own card is the welcome itself: not shown twice.
    assert!(cx.debug_bounds("home-act-card").is_none());
    cx.update(|_, cx| {
        view.update(cx, |v, cx| {
            v.browser_state.act = Some(crate::tmux_snapshot::connection::Act::DaemonUpdate);
            v.browser_state.home_notice = Some("Too many panes to show.".into());
            cx.notify();
        })
    });
    assert!(shown(cx));
    assert!(
        cx.debug_bounds("home-act-card").is_some(),
        "the act card shows"
    );
    assert!(
        cx.debug_bounds("welcome-notice").is_some(),
        "the pane-limit notice shows"
    );
}

#[gpui::test]
fn the_keyboard_moves_between_and_presses_the_buttons(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (view, cx, rx) = home(cx, Some(Phase::Missing), &[], fresh(&dir));
    assert!(shown(cx));
    // The primary has focus first; Return presses it ("I've installed it":
    // a refresh, not setup).
    let focused = |cx: &mut VisualTestContext, i: usize| {
        cx.update(|window, cx| view.read_with(cx, |v, _| v.welcome.focus[i].is_focused(window)))
    };
    assert!(focused(cx, guide::slot::PRIMARY));
    cx.simulate_keystrokes("tab");
    assert!(focused(cx, guide::slot::SKIP), "then Continue without it");
    cx.simulate_keystrokes("tab");
    assert!(focused(cx, guide::slot::RAIL), "then round to the rail");
    cx.simulate_keystrokes("tab");
    assert!(
        focused(cx, guide::slot::SECONDARY),
        "then Copy install command"
    );
    cx.simulate_keystrokes("shift-tab");
    assert!(focused(cx, guide::slot::RAIL));
    cx.simulate_keystrokes("tab tab enter");
    assert!(focused(cx, guide::slot::PRIMARY));
    assert!(
        rx.try_iter()
            .all(|c| !matches!(c, browser::Command::LocalSetup { .. })),
        "I've installed it never starts setup"
    );
    // Continue is disabled until set up, so it is never a stop.
    assert!(!focused(cx, guide::slot::NEXT));
    cx.simulate_keystrokes("tab space");
    assert!(shown(cx), "Continue without it goes on to Machines");
    view.read_with(cx, |v, _| {
        assert_eq!(v.welcome.guide.step, guide::Step::Machines);
        assert!(v.welcome.guide.setup_skipped);
    });
    assert!(saved(&dir, cx).guide.setup_skipped, "saved as it is chosen");
}

#[gpui::test]
fn start_using_opens_the_most_recent_session_and_closes_the_guide(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (view, cx, rx) = home(cx, None, &[("api", "api"), ("notes", "notes")], fresh(&dir));
    assert!(shown(cx));
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            for _ in 0..3 {
                v.guide_act(guide::Act::Next, window, cx);
            }
        })
    });
    draw(cx);
    let start = cx.debug_bounds("welcome-next").unwrap();
    cx.simulate_click(start.center(), Modifiers::default());
    assert!(!view.read_with(cx, |v, _| v.welcome.open));
    assert!(
        rx.try_iter()
            .any(|c| matches!(c, browser::Command::Session { .. }))
    );
    let state = saved(&dir, cx);
    assert!(state.welcomed && state.guide.finished);
    assert_eq!(state.guide.reached, guide::ALL_REACHED);
}

#[test]
fn whats_new_is_due_once_per_version_for_the_welcomed() {
    let mut state = State {
        ready: true,
        welcomed: true,
        version: Some("0.1.17".into()),
        ..Default::default()
    };
    assert_eq!(whats_new::due(&state), whats_new::notes("0.1.17"));
    // A short card: a handful of one-line items, for every version.
    for (version, notes) in whats_new::RELEASES {
        assert!(notes.len() <= 4, "{version}");
    }
    state.whats_new_seen = Some("0.1.17".into());
    assert_eq!(whats_new::due(&state), None, "seen");
    state.whats_new_seen = Some("0.1.16".into());
    assert!(
        whats_new::due(&state).is_some(),
        "a newer version shows again"
    );
    state.open = true;
    assert_eq!(whats_new::due(&state), None, "never over the welcome");
    state.open = false;
    state.welcomed = false;
    assert_eq!(whats_new::due(&state), None, "not on first run");
    state.welcomed = true;
    state.version = Some("9.9.9".into());
    assert_eq!(whats_new::due(&state), None, "a version without notes");
    state.version = None;
    assert_eq!(whats_new::due(&state), None, "outside a bundle");
    assert_eq!(whats_new::notes("Earlier"), None);
}

#[gpui::test]
fn whats_new_shows_on_home_once_and_close_remembers_it(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("gpui-onboarding.json"),
        r#"{"version":1,"welcomed":true,"whats_new_seen":"0.1.16"}"#,
    )
    .unwrap();
    let (view, cx, _rx) = home(cx, None, &[("api", "api")], fresh(&dir));
    draw(cx);
    assert!(cx.debug_bounds("whats-new").is_some());
    assert!(cx.debug_bounds("whats-new-note-2").is_some());
    let close = cx.debug_bounds("whats-new-close").unwrap();
    cx.simulate_click(close.center(), Modifiers::default());
    draw(cx);
    assert!(cx.debug_bounds("whats-new").is_none());
    assert_eq!(saved(&dir, cx).whats_new_seen.as_deref(), Some("0.1.17"));
    cx.update(|_, cx| view.update(cx, |v, _| v.welcome = fresh(&dir)));
    draw(cx);
    assert!(cx.debug_bounds("whats-new").is_none(), "once per version");
}

#[test]
fn the_sessions_already_there_come_most_recent_first() {
    let fleet: browser::fleet::Fleet = serde_json::from_value(serde_json::json!({
        "groups": [{"id": "local", "label": "Local", "state": "ready", "conflict": false,
            "omittedSessions": 0, "sessions": [
                {"id": "notes", "name": "notes", "paneCount": 2, "windowCount": 1,
                 "lastActivity": 100, "sessionId": "n", "selection": "tok-notes"},
                {"id": "api", "name": "api", "paneCount": 4, "windowCount": 2,
                 "lastActivity": 300, "sessionId": "a", "selection": "tok-api"},
                {"id": "gone", "name": "gone", "paneCount": 1,
                 "sessionId": "g", "selection": null}]}],
        "omittedGroups": 0
    }))
    .unwrap();
    let state = browser::State {
        fleet: Some(fleet),
        ..Default::default()
    };
    let known = known_sessions(&state);
    assert_eq!(
        known.iter().map(|k| k.label.as_str()).collect::<Vec<_>>(),
        ["api", "notes"],
        "most recent first; a session that can't be opened is left out"
    );
    assert_eq!(known[0].detail.as_deref(), Some("2 windows · 4 panes"));
    assert_eq!(known[1].detail.as_deref(), Some("1 window · 2 panes"));
    assert_eq!(known[0].open, Open::Fleet("tok-api".into()));
    // Without a machines' table, Home's own list.
    let plain = browser::State {
        sessions: vec![choice("s", "solo")],
        ..Default::default()
    };
    assert_eq!(known_sessions(&plain)[0].open, Open::Session("s".into()));
}

/// The checklist's words read on its card in every catalog theme, at both
/// contrast settings: Home's inks on Bezel's card fill over Home's canvas.
#[test]
fn the_checklist_reads_on_its_card_in_every_theme() {
    use crate::contrast::{Contrast, ratio};
    let pack = |c: Hsla| u32::from(Rgba::from(c)) >> 8;
    let mut failures = Vec::new();
    for (name, mut theme) in crate::tmux_snapshot::ink::tests::catalog_themes() {
        for contrast in [Contrast::Standard, Contrast::High] {
            theme.contrast = contrast;
            let canvas = pack(crate::tmux_snapshot::design::palette(&theme).terminal_bg);
            let bezel = crate::tmux_snapshot::home::palette(&theme, canvas);
            let card = pack(bezel_theme::flatten(
                bezel.card_glass_bg(),
                rgb(canvas).into(),
            ));
            for (role, ink) in [("text", bezel.text), ("muted", bezel.text_muted)] {
                let r = ratio(pack(ink), card);
                if r < 4.5 {
                    failures.push(format!("{name} {contrast:?} {role}: {r:.2}"));
                }
            }
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}
