#![allow(clippy::unwrap_used)]
use super::*;
use crate::tmux_snapshot::browser_ui::Selection;
use crate::tmux_snapshot::{decode, presence::Presence};
use core::prelude::v1::test;
use gpui::*;
use std::{
    cell::RefCell,
    rc::Rc,
    sync::{Arc, mpsc},
};
fn pane(id: &str, window: Option<&str>) -> browser::Choice {
    browser::Choice {
        id: id.into(),
        label: "Pane".into(),
        pane_count: None,
        window_id: window.map(str::to_owned),
        window_label: Some("Same window label".into()),
    }
}
fn make_view(
    window: &mut Window,
    cx: &mut Context<SnapshotView>,
    sender: mpsc::SyncSender<browser::Command>,
) -> SnapshotView {
    let focus = cx.focus_handle();
    focus.focus(window, cx);
    let mut presence = Presence::new(true);
    presence.flush(&sender);
    presence.acknowledge(1);
    let frame = Arc::new(
        decode::frame(include_bytes!("../../../../../../fixtures/snapshot.json")).unwrap(),
    );
    SnapshotView {
        presence,
        _activation: None,
        _appearance: None,
        last_system: None,
        glass: Default::default(),
        last_workspace_session: None,
        pending_session_open: None,
        frame: Some(frame.clone()),
        browsing: true,
        terminal_focus: focus,
        input_interrupted: false,
        picker: None,
        pane_actions: None,
        new_session: None,
        new_session_queued: None,
        window_reveal: Default::default(),
        resize_gesture: Default::default(),
        last_resize: None,
        marked: String::new(),
        marked_selection: None,
        input_geometry: Some((
            Bounds::new(point(px(0.), px(0.)), size(px(500.), px(500.))),
            Bounds::default(),
        )),
        input_cell_width: Some(10.),
        painted_frame: Some(frame.clone()),
        selection: None,
        divider: None,
        wheel: crate::terminal::WheelRemainder::default(),
        browser_request: 7,
        browser_state: browser::State {
            surface: browser::Surface::Workspace,
            input_ready: true,
            sessions: vec![pane("session-a", None)],
            panes: vec![
                pane("pane-a", Some("window-a")),
                pane("pane-b", Some("window-b")),
            ],
            selected_session: Some("session-a".into()),
            selected_pane: Some("pane-a".into()),
            frame: Some(frame),
            regions: serde_json::from_str(
                r#"[{"id":"pane-a","left":0,"top":0,"width":1,"height":1}]"#,
            )
            .unwrap(),
            ..Default::default()
        },
        browser_commands: Some(sender),
        _browser_task: None,
        _task: None,
        painter: Rc::new(RefCell::new(
            crate::terminal_painter::TerminalPainter::default(),
        )),
    }
}

fn drain(view: &mut SnapshotView, mailbox: &browser::Mailbox, cx: &mut Context<SnapshotView>) {
    let publication = mailbox.try_lock().unwrap().take().unwrap();
    view.apply_browser_state(publication, cx);
    assert!(mailbox.try_lock().unwrap().is_none());
}
#[gpui::test]
fn mailbox_old_request_before_and_after_new_ready_cannot_restore_retired_pane(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    let mailbox: browser::Mailbox = Arc::new(std::sync::Mutex::new(None));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.browser_state.request = 7;
            view.browser_state.presence_revision = 1;
            let old = view.browser_state.clone();
            view.marked = "unfinished".into();
            view.select(Selection::Pane("pane-b".into()), window, cx);
            assert!(matches!(
                receiver.try_recv().unwrap(),
                browser::Command::Pane { request: 8, id } if id == "pane-b"
            ));
            assert!(view.frame.is_none());
            assert!(!view.browser_state.input_ready);
            assert!(view.marked.is_empty());

            view.presence = Presence::new(true);
            view.presence.flush(view.browser_commands.as_ref().unwrap());
            assert!(matches!(
                receiver.try_recv().unwrap(),
                browser::Command::Presence {
                    active: true,
                    revision: 1
                }
            ));
            assert!(!view.presence.ready());
            *mailbox.lock().unwrap() = Some(Some(old.clone()));
            drain(view, &mailbox, cx);
            assert_eq!(view.browser_request, 8);
            assert!(
                !view.presence.ready(),
                "stale request must not acknowledge current presence"
            );
            assert!(view.frame.is_none());
            assert!(!view.browser_state.input_ready);
            assert!(receiver.try_recv().is_err());

            let mut current = old.clone();
            current.request = 8;
            current.selected_pane = Some("pane-b".into());
            current.status = "Current pane ready".into();
            current.presence_revision = 1;
            let current_frame = Arc::make_mut(current.frame.as_mut().unwrap());
            current_frame.cells[0].symbol = "B".into();
            let expected = current.frame.clone().unwrap();
            *mailbox.lock().unwrap() = Some(Some(current));
            drain(view, &mailbox, cx);
            assert!(view.presence.ready());
            assert!(view.browser_state.input_ready);
            assert_eq!(view.browser_state.selected_pane.as_deref(), Some("pane-b"));
            assert!(Arc::ptr_eq(view.frame.as_ref().unwrap(), &expected));

            *mailbox.lock().unwrap() = Some(Some(old));
            drain(view, &mailbox, cx);
            assert_eq!(view.browser_state.request, 8);
            assert!(view.presence.ready());
            assert_eq!(view.browser_state.status, "Current pane ready");
            assert_eq!(view.browser_state.selected_pane.as_deref(), Some("pane-b"));
            assert!(Arc::ptr_eq(view.frame.as_ref().unwrap(), &expected));
            assert!(view.browser_state.input_ready);
            assert!(receiver.try_recv().is_err());

            view.marked = "pending".into();
            *mailbox.lock().unwrap() = Some(None);
            drain(view, &mailbox, cx);
            assert!(view.frame.is_none());
            assert!(view.browser_commands.is_none());
            assert!(view.marked.is_empty());
            assert!(view.selection.is_none());
            assert!(view.divider.is_none());
            assert_eq!(
                view.browser_state.status,
                "Connection unavailable — restart the preview"
            );
            assert!(!view.terminal_input_ready());
            assert!(receiver.try_recv().is_err());
        });
    });
}

mod session_open;
