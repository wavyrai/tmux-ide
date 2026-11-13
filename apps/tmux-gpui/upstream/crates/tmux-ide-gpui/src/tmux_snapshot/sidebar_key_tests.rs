//! One case per field of the sidebar's [`Inputs`]: a change the sidebar shows
//! must move that field, and with it the key the paint is kept under. A field
//! that stops following its input fails its case here.
use super::*;
use crate::tmux_snapshot::browser_ui::sidebar_view::Inputs;
use std::{rc::Rc, time::Duration};

type Change = fn(&mut SnapshotView, &mut Window, &mut Context<SnapshotView>);

/// Home with one working agent on its session's row, a favourite button
/// that takes a press, and a connection that has existed.
fn agents() -> browser::State {
    let mut state = browser::State {
        request: 7,
        surface: browser::Surface::Home,
        home_phase: browser::HomePhase::Live,
        input_ready: true,
        selected_session: Some("session-a".into()),
        ..Default::default()
    };
    state.home_agents = Some(
        serde_json::from_value(serde_json::json!({"revision":5,"phase":"live","rows":[
            {"key":"busy","sessionId":"s","paneId":"p1","name":"Busy","sessionLabel":"Session",
             "status":"WORKING","attention":false,"available":true}],
            "observedSessions":1,"totalSessions":1,"truncatedSessions":0,"truncatedRows":0,
            "note":null}))
        .unwrap(),
    );
    state.fleet = Some(
        serde_json::from_value(serde_json::json!({
            "omittedGroups":0,
            "preferences":{"revision":3,"phase":"ready","error":null},
            "groups":[{"id":"local","label":"Local","state":"ready","conflict":false,
                "omittedSessions":0,"sessions":[{"id":"local-s","name":"Session","paneCount":1,
                "sessionId":"s","favoriteAction":"70500000-0000-4000-8000-0000000000fa",
                "selection":"70500000-0000-4000-8000-000000000001"}]}]}))
        .unwrap(),
    );
    state
}

fn appearance(background: u32) -> crate::tmux_snapshot::appearance::Appearance {
    serde_json::from_value(serde_json::json!({
        "selected":"dark", "system":"dark", "error":null,
        "theme":{"canvas":1,"background":background,"foreground":3,"cursor":4,"surface":5,
            "active":6,"muted":7,"accent":8,"palette":vec![9;256]},
        "options":[{"id":"dark","name":"Dark"}]
    }))
    .unwrap()
}

/// The link drops, and the clock passes the point where its words show.
fn drop_the_link(view: &mut SnapshotView, cx: &mut Context<SnapshotView>) {
    let start = std::time::Instant::now();
    let wall = std::time::SystemTime::now();
    view.connection.clock = Rc::new(move || (start, wall));
    view.browser_state.agents_last_known = true;
    view.browser_state.reconnect_attempt = Some(1);
    view.observe_connection(cx);
    let later = start + Duration::from_secs(600);
    view.connection.clock = Rc::new(move || (later, wall));
}

macro_rules! case {
    ($field:ident, $fixture:expr, $change:expr) => {
        (
            stringify!($field),
            $fixture as fn() -> browser::State,
            $change as Change,
            (|a: &Inputs, b: &Inputs| a.$field != b.$field) as fn(&Inputs, &Inputs) -> bool,
        )
    };
}

fn eight() -> browser::State {
    workspace(8)
}

#[gpui::test]
fn each_input_the_sidebar_reads_moves_its_field_and_the_key(cx: &mut TestAppContext) {
    // The appearance bezel paints in is process-wide: hold it, so no test
    // running alongside changes it under this one.
    let _appearance = bezel_theme::lock_appearance();
    let cases = [
        case!(rows, eight, |view, _, _| {
            view.browser_state.fleet = named(8, "renamed").fleet
        }),
        case!(favorites_enabled, agents, |view, _, _| {
            // No bridge to send a press over: the button takes none.
            view.browser_commands = None;
        }),
        case!(preference_revision, agents, |view, _, _| {
            let fleet = view.browser_state.fleet.as_mut().unwrap();
            fleet.preferences.as_mut().unwrap().revision = 4;
        }),
        case!(agents, agents, |view, _, _| {
            view.browser_state.home_agents.as_mut().unwrap().rows[0].name = "Renamed".into();
        }),
        case!(agents_unavailable, agents, |view, _, _| {
            view.browser_state.home_agents.as_mut().unwrap().rows[0].available = false;
        }),
        case!(agents_last_known, agents, |view, _, cx| drop_the_link(
            view, cx
        )),
        case!(local_last_known, agents, |view, _, cx| drop_the_link(
            view, cx
        )),
        case!(home, eight, |view, _, _| {
            view.browser_state.surface = browser::Surface::Home
        }),
        case!(waiting, agents, |view, _, _| {
            view.browser_state.home_agents.as_mut().unwrap().rows[0].attention = true;
        }),
        case!(waiting_last_known, agents, |view, _, cx| drop_the_link(
            view, cx
        )),
        case!(keyboard_active, eight, |view, _, _| {
            view.sidebar_keyboard.active = !view.sidebar_keyboard.active
        }),
        case!(keyboard_selected, eight, |view, _, _| {
            view.sidebar_keyboard.selected =
                Some(crate::tmux_snapshot::browser_ui::sidebar::Target::Home)
        }),
        case!(keyboard_request, eight, |view, _, _| view
            .sidebar_keyboard
            .request += 1),
        case!(keyboard_allowed, eight, |view, _, _| view.marked =
            "あ".into()),
        case!(control_focused, eight, |view, window, cx| {
            // Keyboard navigation is on, so the controls keep the focus.
            view.sidebar_keyboard.active = true;
            view.sidebar_keyboard.request = view.browser_request;
            let controls = std::array::from_fn(|_| cx.focus_handle());
            controls[3].focus(window, cx);
            view.sidebar_keyboard.controls = Some(controls);
        }),
        case!(list_focused, eight, |view, window, cx| {
            let focus = cx.focus_handle();
            focus.focus(window, cx);
            view.sidebar_keyboard.focus = Some(focus);
        }),
        case!(footer_current, eight, |view, _, _| view.browser_commands =
            None),
        case!(request, eight, |view, _, _| view.browser_request += 1),
        case!(appearance_known, eight, |view, _, _| {
            view.browser_state.appearance = Some(appearance(2))
        }),
        case!(local_session_available, agents, |view, _, _| {
            view.browser_state.create_session = Some(browser::CreateSession {
                phase: browser::CreatePhase::Idle,
                error: None,
                revision: 0,
            });
            view.browser_state.local_session_create = Some(browser::local_session::Capability {
                action: "11111111-1111-4111-8111-111111111111".into(),
            });
        }),
        case!(preference_status, agents, |view, _, _| {
            let fleet = view.browser_state.fleet.as_mut().unwrap();
            fleet.preferences.as_mut().unwrap().phase = browser::fleet::PreferencePhase::Saving;
        }),
        case!(connection_stage, agents, |view, _, cx| drop_the_link(
            view, cx
        )),
        case!(connection_words, eight, |view, _, cx| {
            // A first connection still being made says "Connecting…".
            view.browser_state.home_phase = browser::HomePhase::Loading;
            view.observe_connection(cx);
        }),
        case!(connection_card, eight, |view, _, _| {
            view.browser_state.local_setup = Some(browser::local_setup::Setup {
                phase: browser::local_setup::Phase::Available,
            });
        }),
        case!(scroll, eight, |view, _, _| {
            view.sidebar_keyboard
                .scroll
                .set_offset(point(px(0.), px(-12.)))
        }),
        case!(theme, eight, |view, _, _| {
            view.browser_state.appearance = Some(appearance(0x202020))
        }),
        case!(translucent, eight, |view, _, _| {
            let allowed = view.chrome.allowed();
            view.chrome.force(!allowed);
            view.chrome.refresh();
        }),
        case!(reduce_motion, eight, |_, _, cx| {
            use bezel_motion::AppExt as _;
            let reduced = cx.reduced_motion();
            cx.set_reduced_motion(!reduced);
        }),
        case!(agent_motion, eight, |view, _, _| view
            .presence
            .set_active(false)),
        case!(spinner_frame, eight, |view, _, _| {
            // This case's window has no spinner overlay (see below).
            view.agent_animation.set_frame(3)
        }),
    ];
    for (field, fixture, change, moved) in cases {
        // Without the overlay the glyphs animate themselves, by the frame.
        let (snapshot, cx) = if field == "spinner_frame" {
            open_alone(cx, fixture())
        } else {
            open_with(cx, fixture())
        };
        // Read, change and read again inside one update: no frame is drawn
        // in between, so nothing but the change moves a field.
        let ((before, key), (after, new_key)) = cx.update(|window, cx| {
            let read = |window: &Window, cx: &App| {
                let view = snapshot.read(cx);
                (
                    view.sidebar_inputs(window, cx),
                    view.sidebar_key(window, cx),
                )
            };
            let before = read(window, cx);
            snapshot.update(cx, |view, cx| change(view, window, cx));
            (before, read(window, cx))
        });
        assert!(moved(&before, &after), "{field} did not move");
        assert_ne!(key, new_key, "{field} moved and the key did not");
    }
}

/// A window whose root is the view itself, with no spinner overlay.
fn open_alone(
    cx: &mut TestAppContext,
    state: browser::State,
) -> (Entity<SnapshotView>, &mut VisualTestContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    std::mem::forget(receiver);
    let (snapshot, cx) = cx
        .add_window_view(|window, cx| fit_test_support::fixture_view(window, cx, sender, 7, state));
    cx.simulate_resize(size(px(1000.), px(700.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    (snapshot, cx)
}

/// The overlay being there is itself an input: with it the glyphs stand
/// still in the sidebar's paint, without it they animate.
#[gpui::test]
fn the_spinner_overlay_is_an_input(cx: &mut TestAppContext) {
    let read = |snapshot: &Entity<SnapshotView>, cx: &mut VisualTestContext| {
        cx.update(|window, cx| snapshot.read(cx).sidebar_inputs(window, cx))
    };
    let (mounted, cx_a) = open_with(cx, workspace(8));
    let with = read(&mounted, cx_a);
    assert!(with.spinner_attached && with.spinner_frame.is_none());
    let (alone, cx_b) = open_alone(cx, workspace(8));
    let without = read(&alone, cx_b);
    assert!(!without.spinner_attached && without.spinner_frame.is_some());
}

/// Hiding the sidebar forgets its key: when it is shown again it is drawn,
/// whatever it showed before.
#[gpui::test]
fn a_hidden_sidebar_is_drawn_when_it_is_shown_again(cx: &mut TestAppContext) {
    let (snapshot, cx) = open(cx);
    let renders = |cx: &mut VisualTestContext| {
        cx.update(|_, cx| crate::tmux_snapshot::browser_ui::sidebar_view::renders(cx))
    };
    let frame = |cx: &mut VisualTestContext, hidden: bool| {
        cx.update(|window, cx| {
            snapshot.update(cx, |view, cx| {
                view.sidebar_hidden = hidden;
                cx.notify();
            });
            window.draw(cx).clear(cx);
        });
    };
    frame(cx, true);
    assert!(
        cx.update(|_, cx| snapshot.read(cx).sidebar_view_forgotten()),
        "the hidden sidebar kept its key"
    );
    let before = renders(cx);
    frame(cx, false);
    assert_eq!(renders(cx), before + 1, "shown again without a render");
}
