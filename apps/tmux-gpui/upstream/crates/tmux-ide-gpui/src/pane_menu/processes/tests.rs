#![allow(clippy::unwrap_used)]

use super::*;
use crate::processes::{Command, Daemon, Row};
use core::prelude::v1::test;
use herdr_client::protocol::ClientShellSnapshot;
use std::sync::Arc;

fn row(pid: u32, depth: usize) -> Row {
    Row {
        entry: crate::processes::Entry {
            identity: Identity { pid, started: 1 },
            parent: None,
            name: format!("proc{pid}"),
            command: format!("proc{pid} --flag"),
            cpu: Some(1.5),
            memory: 3 << 20,
        },
        depth,
        foreground: pid == 20,
    }
}

fn listing(pids: &[(u32, usize)]) -> Update {
    Update::Listing(Ok(Listing {
        rows: pids.iter().map(|(pid, depth)| row(*pid, *depth)).collect(),
        hidden: 0,
        cpu: 4.5,
        memory: 9 << 20,
    }))
}

#[test]
fn numbers_and_reports_read_as_sentences() {
    assert_eq!(cpu_text(None), "–");
    assert_eq!(cpu_text(Some(0.04)), "0.0%");
    assert_eq!(cpu_text(Some(9.94)), "9.9%");
    assert_eq!(cpu_text(Some(250.4)), "250%");
    assert_eq!(memory_text(512 << 10), "0.5 MB");
    assert_eq!(memory_text(300 << 20), "300 MB");
    assert_eq!(memory_text(3 << 30), "3.0 GB");
    let at = |pid| Identity { pid, started: 1 };
    assert_eq!(
        report(&[
            (at(1), Outcome::Signalled),
            (at(2), Outcome::Signalled),
            (at(3), Outcome::Refused(Refusal::Exited)),
            (at(4), Outcome::Refused(Refusal::Elsewhere)),
            (at(5), Outcome::Failed),
        ]),
        "Asked 2 processes to quit. 1 had already exited. \
         1 no longer under this pane, left running. 1 could not be signalled."
    );
}

#[gpui::test]
fn choosing_confirming_and_ending_exact_processes(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        crate::bind_keys(cx);
        let mut view = crate::sidebar::layout_tests::fixture_window(window, cx);
        let mut snapshot: ClientShellSnapshot = serde_json::from_str(include_str!(
            "../../../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"
        ))
        .unwrap();
        let mut pane = snapshot.panes[0].clone();
        pane.pane_id = "inactive".into();
        snapshot.panes.push(pane);
        view.live.snapshot = Some(Arc::new(snapshot));
        view
    });
    cx.simulate_resize(size(px(900.), px(700.)));
    let (watch, updates, commands) = Watch::fake();
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.open_pane_menu("inactive", point(px(10.), px(10.)), window, cx);
            let pane = v.menu.pane.as_mut().unwrap();
            // The fixture's endpoint is not on this machine.
            assert!(
                !pane
                    .actions()
                    .iter()
                    .any(|a| matches!(a, super::super::Action::Processes))
            );
            pane.daemon = Some(Daemon::Default);
            assert!(
                pane.actions()
                    .iter()
                    .any(|a| matches!(a, super::super::Action::Processes))
            );
            v.show_pane_processes(watch, cx);
            assert_eq!(v.menu.page, Some(Page::PaneProcesses));
        });
        window.draw(cx).clear(cx);
    });
    updates.send(listing(&[(10, 0), (20, 1), (30, 2)])).unwrap();
    let tick = |cx: &mut VisualTestContext| {
        cx.update(|window, cx| {
            view.update(cx, |v, cx| v.poll_pane_processes(cx));
            window.draw(cx).clear(cx);
        })
    };
    tick(cx);
    for selector in ["pane-process-0", "pane-process-1", "pane-process-2"] {
        assert!(cx.debug_bounds(selector).is_some(), "{selector}");
    }
    let chosen = |cx: &mut VisualTestContext| {
        view.read_with(cx, |v, _| {
            let processes = v.menu.pane.as_ref().unwrap().processes.as_ref().unwrap();
            processes.chosen.iter().map(|i| i.pid).collect::<Vec<_>>()
        })
    };
    // The pane's own process cannot be chosen; it ends with the pane.
    let root = cx.debug_bounds("pane-process-0").unwrap().center();
    cx.simulate_click(root, Modifiers::default());
    assert!(chosen(cx).is_empty());
    cx.simulate_keystrokes("down space");
    assert!(chosen(cx).is_empty());
    cx.simulate_keystrokes("down space");
    assert_eq!(chosen(cx), [20]);
    let third = cx.debug_bounds("pane-process-2").unwrap().center();
    cx.simulate_click(third, Modifiers::default());
    assert_eq!(chosen(cx), [20, 30]);
    // 30 exits before the user confirms: it is no longer chosen.
    updates.send(listing(&[(10, 0), (20, 1)])).unwrap();
    tick(cx);
    assert_eq!(chosen(cx), [20]);

    cx.simulate_keystrokes("enter");
    assert!(view.read_with(cx, |v, _| v.menu.page == Some(Page::KillProcesses)));
    cx.simulate_keystrokes("escape");
    assert!(view.read_with(cx, |v, _| v.menu.page == Some(Page::PaneProcesses)));
    assert!(commands.try_recv().is_err());
    cx.simulate_keystrokes("enter");
    tick(cx);
    let confirm = cx.debug_bounds("pane-processes-confirm").unwrap().center();
    cx.simulate_click(confirm, Modifiers::default());
    assert_eq!(
        commands.try_recv().unwrap(),
        Command::Kill(vec![Identity {
            pid: 20,
            started: 1
        }])
    );
    assert!(view.read_with(cx, |v, _| v.menu.page == Some(Page::PaneProcesses)));
    // While the worker is ending them, another kill is not offered.
    cx.simulate_keystrokes("enter");
    assert!(view.read_with(cx, |v, _| v.menu.page == Some(Page::PaneProcesses)));

    updates
        .send(Update::Killed(vec![(
            Identity {
                pid: 20,
                started: 1,
            },
            Outcome::Signalled,
        )]))
        .unwrap();
    tick(cx);
    assert!(chosen(cx).is_empty());
    view.read_with(cx, |v, _| {
        let processes = v.menu.pane.as_ref().unwrap().processes.as_ref().unwrap();
        assert_eq!(
            processes.report.as_deref(),
            Some("Asked 1 process to quit.")
        );
        assert!(!processes.ending);
    });

    // A replaced connection stops the list rather than signalling for it.
    cx.update(|_, cx| view.update(cx, |v, _| v.selection_epoch += 1));
    tick(cx);
    view.read_with(cx, |v, _| {
        let processes = v.menu.pane.as_ref().unwrap().processes.as_ref().unwrap();
        assert!(processes.watch.is_none());
        assert!(processes.error.is_some());
    });
    cx.simulate_keystrokes("escape");
    assert!(view.read_with(cx, |v, _| v.menu.page.is_none()));
}
