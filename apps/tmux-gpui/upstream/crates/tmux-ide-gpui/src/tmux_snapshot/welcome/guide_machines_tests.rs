//! The guide's Machines step (onboarding phase 2): this Mac first and each
//! saved machine with its status, adding through the add-machine path, Host
//! suggestions from a fixture SSH config, and ssh's own failure words.
#![allow(clippy::unwrap_used)]
use super::guide::{Act as G, Step, slot};
use super::guide_machines::*;
use super::tests::{draw, fresh, home};
use super::*;
use core::prelude::v1::test;
use std::sync::mpsc::Receiver;

const SPARK: &str = "0b4f5d1e-3c2a-4e8b-9f6d-7a1c2e3b4d5f";
const BUILD: &str = "6c1e2d3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";

fn registry(machines: &[(&str, &str, bool)]) -> browser::machines::Registry {
    browser::machines::Registry {
        revision: 3,
        available: true,
        pending: false,
        error: None,
        message: None,
        machines: machines
            .iter()
            .map(|(id, target, enabled)| browser::machines::Profile {
                id: (*id).into(),
                label: (*target).into(),
                ssh_target: (*target).into(),
                expected_environment_id: None,
                enabled: *enabled,
            })
            .collect(),
    }
}
/// Machines in the window's machine list: id, state and session names.
fn fleet(groups: &[(&str, &str, &[&str])]) -> browser::fleet::Fleet {
    let groups: Vec<_> = groups
        .iter()
        .map(|(id, state, sessions)| {
            serde_json::json!({
                "id": id, "label": id, "state": state, "conflict": false,
                "omittedSessions": 0,
                "sessions": sessions.iter().map(|s| serde_json::json!({
                    "id": format!("{id}/{s}"), "name": s, "paneCount": 1,
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    serde_json::from_value(serde_json::json!({ "groups": groups, "omittedGroups": 0 })).unwrap()
}
fn live() -> browser::State {
    browser::State {
        surface: browser::Surface::Home,
        home_phase: browser::HomePhase::Live,
        ..Default::default()
    }
}
fn statuses(rows: &[Row]) -> Vec<(String, String)> {
    rows.iter()
        .map(|r| (r.label.clone(), r.status.clone()))
        .collect()
}

#[test]
fn this_mac_first_then_each_saved_machine_with_its_status() {
    let mut state = live();
    state.machines = Some(registry(&[
        (SPARK, "spark", true),
        (BUILD, "build", true),
        ("9e8d7c6b-5a49-4382-a1b0-c9d8e7f6a5b4", "old", false),
        ("1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", "later", true),
    ]));
    state.fleet = Some(fleet(&[
        ("local", "ready", &["api", "web", "docs"]),
        (SPARK, "ready", &["train"]),
        (BUILD, "connecting", &[]),
    ]));
    let rows = rows(&state, true, None);
    assert_eq!(
        statuses(&rows),
        [
            ("This Mac".into(), "3 sessions".into()),
            ("spark".into(), "Connected · 1 session".into()),
            ("build".into(), "Connecting…".into()),
            ("old".into(), "Turned off".into()),
            ("later".into(), "Saved".into()),
        ]
    );
    assert!(rows.iter().all(|r| r.problem.is_none()));
    // Without the machine list, this Mac's own Home answers.
    let mut state = live();
    state.sessions = vec![];
    assert_eq!(
        statuses(&rows_of(&state)),
        [("This Mac".into(), "0 sessions".into())]
    );
}
fn rows_of(state: &browser::State) -> Vec<Row> {
    rows(state, true, None)
}

/// A machine that couldn't connect says why: ssh's own words when it gave
/// them, else what to check; it stays saved and can be tried again.
#[test]
fn a_machine_that_could_not_connect_says_why_in_ssh_s_words() {
    let mut state = live();
    state.machines = Some(registry(&[(SPARK, "spark", true), (BUILD, "build", true)]));
    state.fleet = Some(fleet(&[
        ("local", "ready", &[]),
        (BUILD, "disconnected", &[]),
    ]));
    state.ssh_failure = Some(browser::SshFailure {
        machine: SPARK.into(),
        said: "Permission denied (publickey).".into(),
    });
    let rows = rows_of(&state);
    assert_eq!(rows[1].status, "Couldn't connect");
    assert_eq!(
        rows[1].problem.as_deref(),
        Some("spark: ssh said “Permission denied (publickey).”. The machine stays saved.")
    );
    assert_eq!(rows[1].retry.as_deref(), Some("spark"));
    assert_eq!(
        rows[2].problem.as_deref(),
        Some(
            "build: couldn't connect. Check that ssh build works in Terminal, then try again. The machine stays saved."
        )
    );
    // The guide's own add that Home stopped on, before any machine list.
    let mut state = live();
    state.machines = Some(registry(&[(SPARK, "spark", true)]));
    state.home_phase = browser::HomePhase::Unavailable;
    let attempt = Attempt {
        target: "spark".into(),
        revision: 2,
    };
    let rows = rows_of_attempt(&state, &attempt);
    assert_eq!(rows[1].status, "Couldn't connect");
    assert_eq!(rows[1].retry.as_deref(), Some("spark"));
}

/// An add shows at once, then joins the saved list; one that the saved list
/// answered without it says so and can be tried again.
#[test]
fn an_add_shows_saving_until_the_saved_list_answers() {
    let mut state = live();
    let mut saved = registry(&[]);
    saved.pending = true;
    state.machines = Some(saved.clone());
    let attempt = Attempt {
        target: "user@spark".into(),
        revision: 3,
    };
    assert_eq!(
        statuses(&rows(&state, true, Some(&attempt)))[1],
        ("user@spark".into(), "Saving…".into())
    );
    saved.pending = false;
    saved.revision = 4;
    saved.error = Some("Saved machines changed. Refresh and select the machine again.".into());
    state.machines = Some(saved);
    let rows = rows_of_attempt(&state, &attempt);
    assert_eq!(rows[1].status, "Not saved");
    assert_eq!(
        rows[1].problem.as_deref(),
        Some("Saved machines changed. Refresh and select the machine again.")
    );
    assert_eq!(rows[1].retry.as_deref(), Some("user@spark"));
    // Saved and connecting: the machine's own row.
    let mut state = live();
    state.machines = Some(registry(&[(SPARK, "user@spark", true)]));
    assert_eq!(
        statuses(&rows_of_attempt(&state, &attempt)),
        [
            ("This Mac".into(), "0 sessions".into()),
            ("user@spark".into(), "Connecting…".into())
        ]
    );
}
fn rows_of_attempt(state: &browser::State, attempt: &Attempt) -> Vec<Row> {
    rows(state, true, Some(attempt))
}

#[test]
fn machines_need_the_service_and_the_saved_list() {
    let mut state = live();
    assert_eq!(service(&state, false), Service::Down);
    assert_eq!(service(&state, true), Service::Loading);
    state.machines = Some(registry(&[]));
    assert_eq!(service(&state, true), Service::Ready);
    state.local_setup = Some(browser::local_setup::Setup {
        phase: Phase::Available,
    });
    assert_eq!(service(&state, true), Service::Down);
}

/// The step writes saved machines only through the add-machine path: no
/// registry change and no command of its own.
#[test]
fn the_step_adds_machines_only_through_the_add_machine_path() {
    let source = include_str!("guide_machines.rs");
    for writer in [
        "Operation::Mutate",
        "Change::",
        "Command::Machine {",
        "MachineProfile",
    ] {
        assert!(!source.contains(writer), "{writer}");
    }
    assert_eq!(source.matches("Selection::Machine(").count(), 1);
}

// The view.

fn at_machines<'a>(
    cx: &'a mut TestAppContext,
    dir: &tempfile::TempDir,
    saved: browser::machines::Registry,
    home_dir: Option<PathBuf>,
) -> (
    Entity<SnapshotView>,
    &'a mut VisualTestContext,
    Receiver<browser::Command>,
) {
    let mut welcome = fresh(dir);
    welcome.guide.machines.home = home_dir;
    let (view, cx, rx) = home(cx, None, &[("api", "api")], welcome);
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.browser_state.machines = Some(saved);
            v.guide_act(G::Next, window, cx);
        })
    });
    draw(cx);
    cx.run_until_parked();
    draw(cx);
    assert_eq!(
        view.read_with(cx, |v, _| v.welcome.guide.step),
        Step::Machines
    );
    (view, cx, rx)
}
fn machine_commands(rx: &Receiver<browser::Command>) -> Vec<Option<String>> {
    rx.try_iter()
        .filter_map(|c| match c {
            browser::Command::Machine { ssh_target, .. } => Some(ssh_target),
            _ => None,
        })
        .collect()
}
fn click(cx: &mut VisualTestContext, selector: &'static str) {
    let bounds = cx
        .debug_bounds(selector)
        .unwrap_or_else(|| panic!("{selector} is drawn"));
    cx.simulate_click(bounds.center(), Modifiers::default());
    draw(cx);
}
fn typed(view: &Entity<SnapshotView>, cx: &mut VisualTestContext, text: &str) {
    cx.update(|_, cx| {
        view.update(cx, |v, cx| {
            let field = v.welcome.guide.machines.field.clone().unwrap();
            field.update(cx, |input, cx| input.set_text_selected(text, cx));
        })
    });
    draw(cx);
}
fn field_focused(view: &Entity<SnapshotView>, cx: &mut VisualTestContext) -> bool {
    cx.update(|window, cx| {
        view.read_with(cx, |v, cx| {
            v.welcome
                .guide
                .machines
                .field
                .as_ref()
                .unwrap()
                .read(cx)
                .focus
                .is_focused(window)
        })
    })
}

/// Typing a machine and Return adds it through Connect to machine…'s path;
/// a target that path refuses says so and sends nothing.
#[gpui::test]
fn return_in_the_field_adds_the_machine_through_the_add_path(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (view, cx, rx) = at_machines(cx, &dir, registry(&[]), None);
    assert!(
        field_focused(&view, cx),
        "the field is the step's first stop"
    );
    assert_eq!(
        view.read_with(cx, |v, _| v.machines_next_label()),
        SKIP_FOR_NOW
    );
    typed(&view, cx, "a/b");
    cx.simulate_keystrokes("enter");
    draw(cx);
    assert!(machine_commands(&rx).is_empty());
    assert_eq!(
        view.read_with(cx, |v, _| v.welcome.guide.machines.error),
        Some(INVALID)
    );
    assert_eq!(
        view.read_with(cx, |v, _| v.welcome.guide.step),
        Step::Machines,
        "Return never means Continue in the field"
    );
    typed(&view, cx, "user@spark");
    cx.simulate_keystrokes("enter");
    draw(cx);
    assert_eq!(machine_commands(&rx), [Some("user@spark".to_string())]);
    view.read_with(cx, |v, cx| {
        let machines = &v.welcome.guide.machines;
        assert_eq!(machines.error, None);
        assert_eq!(machines.attempt.as_ref().unwrap().target, "user@spark");
        assert_eq!(machines.field.as_ref().unwrap().read(cx).text(), "");
        assert!(v.welcome.open, "the guide stays while it connects");
        assert_eq!(v.machines_next_label(), "Continue");
    });
    assert!(
        cx.debug_bounds("welcome-machine-1").is_some(),
        "its row shows at once"
    );
}

/// Space types in the field rather than pressing anything; Tab goes on to
/// Add, which adds as Return does.
#[gpui::test]
fn the_field_keeps_space_and_tab_reaches_add(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (view, cx, rx) = at_machines(cx, &dir, registry(&[]), None);
    cx.simulate_keystrokes("space");
    assert!(machine_commands(&rx).is_empty());
    assert_eq!(
        view.read_with(cx, |v, _| v.welcome.guide.step),
        Step::Machines
    );
    typed(&view, cx, "spark");
    cx.simulate_keystrokes("tab");
    assert!(cx.update(|window, cx| {
        view.read_with(cx, |v, _| v.welcome.focus[slot::ADD].is_focused(window))
    }));
    cx.simulate_keystrokes("enter");
    draw(cx);
    assert_eq!(machine_commands(&rx), [Some("spark".to_string())]);
}

/// The SSH config's literal Hosts are offered, minus those already saved;
/// clicking one adds it. Nothing connects before the click.
#[gpui::test]
fn a_host_from_the_ssh_config_is_one_click(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let home_dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(home_dir.path().join(".ssh")).unwrap();
    std::fs::write(
        home_dir.path().join(".ssh/config"),
        "Host *\n  User me\nHost build\nHost spark\nProxyCommand nc %h %p\n",
    )
    .unwrap();
    let (_view, cx, rx) = at_machines(
        cx,
        &dir,
        registry(&[(BUILD, "build", true)]),
        Some(home_dir.path().to_path_buf()),
    );
    assert!(
        machine_commands(&rx).is_empty(),
        "nothing connects by itself"
    );
    assert!(cx.debug_bounds("welcome-host-0").is_some());
    assert!(
        cx.debug_bounds("welcome-host-1").is_none(),
        "build is saved already"
    );
    click(cx, "welcome-host-0");
    assert_eq!(machine_commands(&rx), [Some("spark".to_string())]);
}

/// A failed machine's Try again goes through the same path; Copy details
/// puts the words on the clipboard.
#[gpui::test]
fn try_again_and_copy_details(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (view, cx, rx) = at_machines(cx, &dir, registry(&[(SPARK, "spark", true)]), None);
    cx.update(|_, cx| {
        view.update(cx, |v, cx| {
            v.browser_state.ssh_failure = Some(browser::SshFailure {
                machine: SPARK.into(),
                said: "ssh: connect to host spark port 22: No route to host".into(),
            });
            cx.notify();
        })
    });
    draw(cx);
    assert!(cx.debug_bounds("welcome-machine-problem-0").is_some());
    click(cx, "welcome-copy-0");
    let copied = cx.update(|_, cx| cx.read_from_clipboard().and_then(|c| c.text()));
    assert_eq!(
        copied.as_deref(),
        Some(
            "spark: ssh said “ssh: connect to host spark port 22: No route to host”. The machine stays saved."
        )
    );
    click(cx, "welcome-retry-0");
    assert_eq!(machine_commands(&rx), [Some("spark".to_string())]);
}

/// With setup not done, the step says machines need the service and its
/// controls do nothing.
#[gpui::test]
fn without_the_service_the_step_says_so_and_adds_nothing(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (view, cx, rx) = home(cx, Some(Phase::Failed), &[], fresh(&dir));
    cx.update(|window, cx| view.update(cx, |v, cx| v.guide_act(G::ContinueWithout, window, cx)));
    draw(cx);
    assert_eq!(
        view.read_with(cx, |v, _| v.welcome.guide.step),
        Step::Machines
    );
    assert!(cx.debug_bounds("welcome-machine-message").is_some());
    assert!(!field_focused(&view, cx), "a disabled field is no stop");
    click(cx, "welcome-machine-add");
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.guide_act(G::Connect("spark".into()), window, cx)
        })
    });
    assert!(machine_commands(&rx).is_empty());
}

/// Machines is second, and every keyboard stop has its own focus handle:
/// the rail keeps room for all five steps.
#[test]
fn machines_is_second_and_no_two_stops_share_a_slot() {
    use slot::*;
    assert_eq!(Step::ALL[1], Step::Machines);
    assert_eq!(Step::Machines.place(), 2);
    let mut slots = vec![
        SECONDARY, PRIMARY, SKIP, BACK, NEXT, SEGMENT, GRID, GRID_DARK, FONT_DOWN, FONT_UP, CURSOR,
        OPAQUE, FIELD, ADD,
    ];
    slots.extend((0..5).map(|i| RAIL + i));
    slots.extend((0..MANY).flat_map(|i| [CHIP + i, RETRY + i, COPY + i]));
    let count = slots.len();
    slots.sort_unstable();
    slots.dedup();
    assert_eq!(slots.len(), count, "a slot is shared");
    assert!(slots.iter().all(|s| *s < COUNT));
    assert!(Step::ALL.len() <= 5);
}
