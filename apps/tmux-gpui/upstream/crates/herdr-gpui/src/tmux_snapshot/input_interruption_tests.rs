#![allow(clippy::unwrap_used)]
use super::*;
use crate::tmux_snapshot::{decode, keys::Input, presence::Presence};
use core::prelude::v1::test;
use std::{
    cell::RefCell,
    rc::Rc,
    sync::{Arc, mpsc},
};

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
    let frame =
        Arc::new(decode::frame(include_bytes!("../../../../../fixtures/snapshot.json")).unwrap());
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
            input_ready: false,
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
fn key(value: &str) -> KeyDownEvent {
    KeyDownEvent {
        keystroke: Keystroke::parse(value).unwrap(),
        is_held: false,
        prefer_character_input: false,
    }
}
#[gpui::test]
fn interrupted_prefix_cannot_send_suffix_or_enter_after_authority_arrives(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    while receiver.try_recv().is_ok() {}
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.terminal_key(&key("e"), window, cx);
            view.replace_text_in_range(None, "e", window, cx);
            assert!(receiver.try_recv().is_err());
            view.browser_state.input_ready = true;
            view.replace_text_in_range(None, "WINDOW_ONE_OK", window, cx);
            view.terminal_key(&key("enter"), window, cx);
            assert!(
                receiver.try_recv().is_err(),
                "authority arrival must not admit an interrupted command suffix"
            );
        })
    });
}

fn click(view: &mut SnapshotView, window: &mut Window, cx: &mut Context<SnapshotView>) {
    view.input_geometry = Some((
        Bounds::new(point(px(0.), px(0.)), size(px(500.), px(500.))),
        Bounds::default(),
    ));
    view.input_cell_width = Some(10.);
    view.painted_frame = view.frame.clone();
    view.terminal_click(
        &MouseDownEvent {
            position: point(px(5.), px(5.)),
            button: MouseButton::Left,
            ..Default::default()
        },
        window,
        cx,
    );
}
#[gpui::test]
fn premature_click_requires_new_ready_click_and_never_replays(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    while receiver.try_recv().is_ok() {}
    cx.update(|window,cx| view.update(cx, |view,cx| {
        window.blur(cx);
        view.presence.set_active(false);
        click(view,window,cx);
        assert!(view.terminal_focus.is_focused(window), "early click must expose keydown without text handler");
        view.presence = Presence::new(true);
        view.presence.flush(view.browser_commands.as_ref().unwrap());
        view.presence.acknowledge(1);
        view.browser_state.input_ready = true;
        while receiver.try_recv().is_ok() {}
        view.replace_text_in_range(None,"suffix",window,cx);
        view.terminal_key(&key("enter"),window,cx);
        view.terminal_key(&key("ctrl-c"),window,cx);
        view.queue_input(Input::Paste("suffix".into()),cx);
        assert!(receiver.try_recv().is_err());
        // A stale painted frame cannot arm input.
        view.painted_frame = None;
        view.terminal_click(&MouseDownEvent { position:point(px(5.),px(5.)),button:MouseButton::Left,..Default::default() },window,cx);
        view.replace_text_in_range(None,"still blocked",window,cx);
        assert!(receiver.try_recv().is_err());
        click(view,window,cx);
        view.replace_text_in_range(None,"echo WHOLE",window,cx);
        view.terminal_key(&key("enter"),window,cx);
        assert!(matches!(receiver.try_recv().unwrap(),browser::Command::Input { input:Input::Text(t), .. } if t=="echo WHOLE"));
        assert!(matches!(receiver.try_recv().unwrap(),browser::Command::Input { input:Input::Key(k), .. } if k=="Enter"));
        assert!(receiver.try_recv().is_err(), "no rejected prefix or suffix is replayed");
    }));
}
#[gpui::test]
fn ready_click_and_application_shortcuts_do_not_interrupt_input(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    while receiver.try_recv().is_ok() {}
    cx.update(|window,cx| view.update(cx, |view,cx| {
        view.terminal_key(&key("cmd-q"),window,cx);
        assert!(!view.input_interrupted, "application quit is not a terminal gesture");
        view.browser_state.input_ready=true;
        click(view,window,cx);
        view.replace_text_in_range(None,"complete",window,cx);
        assert!(matches!(receiver.try_recv().unwrap(),browser::Command::Input { input:Input::Text(t), .. } if t=="complete"));
        assert!(receiver.try_recv().is_err());
    }));
}
#[gpui::test]
fn interrupted_input_survives_target_and_readiness_changes_but_local_scroll_remains(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    while receiver.try_recv().is_ok() {}
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.replace_and_mark_text_in_range(None, "early", None, window, cx);
            assert!(view.marked.is_empty());
            let frame = view.frame.clone();
            view.select(Selection::Pane("pane-b".into()), window, cx);
            view.browser_state.selected_pane = Some("pane-b".into());
            view.browser_state.input_ready = true;
            view.frame = frame;
            view.terminal_focus.focus(window, cx);
            while receiver.try_recv().is_ok() {}
            view.replace_text_in_range(None, "late", window, cx);
            view.terminal_key(&key("enter"), window, cx);
            assert!(receiver.try_recv().is_err());
            view.terminal_key(&key("shift-end"), window, cx);
            assert!(matches!(
                receiver.try_recv().unwrap(),
                browser::Command::Input {
                    input: Input::Scroll(0),
                    ..
                }
            ));
            assert!(
                view.input_interrupted,
                "local history control cannot re-arm terminal input"
            );
        })
    });
}

#[gpui::test]
fn queue_recovery_cannot_send_suffix_after_a_dropped_terminal_command(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    while receiver.try_recv().is_ok() {}
    cx.update(|window,cx| view.update(cx, |view,cx| {
        view.browser_state.input_ready=true;
        click(view,window,cx);
        let sender=view.browser_commands.as_ref().unwrap();
        for _ in 0..32 { sender.try_send(browser::Command::Presence { active:true, revision:1 }).unwrap(); }
        view.replace_text_in_range(None,"lost prefix",window,cx);
        while receiver.try_recv().is_ok() {}
        view.browser_state.input_ready=true;
        view.replace_text_in_range(None,"suffix",window,cx);
        view.terminal_key(&key("enter"),window,cx);
        assert!(receiver.try_recv().is_err());
        click(view,window,cx);
        view.replace_text_in_range(None,"new whole command",window,cx);
        assert!(matches!(receiver.try_recv().unwrap(),browser::Command::Input { input:Input::Text(t), .. } if t=="new whole command"));
        assert!(receiver.try_recv().is_err());
    }));
}
#[gpui::test]
fn focused_key_dispatch_observes_input_without_appkit_handler(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    while receiver.try_recv().is_ok() {}
    cx.simulate_keystrokes("e");
    assert!(view.read_with(cx, |view, _| view.input_interrupted));
    cx.update(|_, cx| view.update(cx, |view, _| view.browser_state.input_ready = true));
    cx.simulate_keystrokes("enter ctrl-c cmd-v");
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn dropped_drag_prefix_stays_interrupted_after_release_until_ready_click(cx: &mut TestAppContext) {
    use herdr_client::protocol::{CellData, FrameData};
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| view.update(cx, |view, cx| {
        let frame = Arc::new(FrameData { width: 11, height: 9, cursor: None, hyperlinks: vec![], graphics: vec![],
            cells: vec![CellData { symbol: " ".into(), fg: 0, bg: 0, modifier: 0, skip: false, hyperlink: None }; 99] });
        view.frame = Some(frame.clone());
        view.browser_state.frame = Some(frame);
        view.browser_state.request = 7;
        view.browser_state.input_ready = true;
        view.browser_state.selected_session = Some("session".into());
        view.browser_state.resize_token = Some("312b2c16-a13d-4411-82e5-1fdb58adab92".into());
        view.browser_state.regions = serde_json::from_str(r#"[{"id":"pane-a","left":0,"top":0,"width":5,"height":9},{"id":"pane-b","left":6,"top":0,"width":5,"height":9}]"#).unwrap();
        view.browser_state.panes = ["pane-a", "pane-b"].into_iter().map(|id| browser::Choice { id:id.into(), label:id.into(), pane_count:None, window_id:Some("window".into()), window_label:None }).collect();
        for offered in 0..3 {
            click(view, window, cx);
            assert!(!view.input_interrupted);
            assert!(view.begin_divider(point(px(55.), px(20.)), cx));
            assert!(!view.input_interrupted, "starting resize alone is not dropped input");
            match offered {
                0 => view.terminal_key(&key("e"), window, cx),
                1 => view.replace_text_in_range(None, "prefix", window, cx),
                _ => view.queue_input(Input::Paste("prefix".into()), cx),
            }
            assert!(view.input_interrupted);
            assert!(view.divider.is_some(), "input interruption must not cancel resize");
            assert!(receiver.try_recv().is_err());
            view.move_divider(point(px(65.), px(20.)), true, cx);
            assert!(matches!(receiver.try_recv().unwrap(), browser::Command::ResizePane { .. }));
            view.replace_text_in_range(None, "suffix", window, cx);
            view.terminal_key(&key("enter"), window, cx);
            assert!(receiver.try_recv().is_err(), "release cannot admit the dropped command suffix");
            click(view, window, cx);
            view.replace_text_in_range(None, "whole", window, cx);
            view.terminal_key(&key("enter"), window, cx);
            assert!(matches!(receiver.try_recv().unwrap(), browser::Command::Input { input: Input::Text(text), .. } if text == "whole"));
            assert!(matches!(receiver.try_recv().unwrap(), browser::Command::Input { input: Input::Key(key), .. } if key == "Enter"));
            assert!(receiver.try_recv().is_err());
        }
        click(view, window, cx);
        assert!(view.begin_divider(point(px(55.), px(20.)), cx));
        view.terminal_key(&key("cmd-q"), window, cx);
        assert!(!view.input_interrupted);
        view.terminal_key(&key("escape"), window, cx);
        assert!(view.divider.is_none());
        assert!(!view.input_interrupted, "local cancellation did not drop terminal input");
        assert!(receiver.try_recv().is_err());
    }));
}

#[path = "wheel_event_tests.rs"]
mod wheel_event_tests;
