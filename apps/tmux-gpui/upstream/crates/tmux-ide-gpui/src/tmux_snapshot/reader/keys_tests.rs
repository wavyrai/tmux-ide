//! #756 review round 1, item 1: a painted reader pane takes every key, paste
//! and IME text; nothing reaches the `tmux-ide show` process below, whatever
//! the reader's state. From review-reader's probe.
#![allow(clippy::unwrap_used)]
use super::*;
use crate::tmux_snapshot::reader::{Published, Status};
use std::sync::{Arc, mpsc};

fn setup(
    view: &mut SnapshotView,
    window: &mut Window,
    cx: &mut Context<SnapshotView>,
    status: Status,
) {
    use herdr_client::protocol::{CellData, FrameData};
    let frame = Arc::new(FrameData {
        width: 11,
        height: 9,
        cursor: None,
        hyperlinks: vec![],
        graphics: vec![],
        cells: vec![
            CellData {
                symbol: " ".into(),
                fg: 0,
                bg: 0,
                modifier: 0,
                skip: false,
                hyperlink: None
            };
            99
        ],
    });
    view.frame = Some(crate::tmux_snapshot::display_frame::DisplayFrame::Legacy(
        frame.clone(),
    ));
    view.browser_state.frame = Some(crate::tmux_snapshot::display_frame::DisplayFrame::Legacy(
        frame,
    ));
    view.browser_state.request = 7;
    view.browser_state.input_ready = true;
    view.browser_state.selected_session = Some("session".into());
    view.browser_state.regions =
        serde_json::from_str(r#"[{"id":"pane-a","left":0,"top":0,"width":11,"height":9}]"#)
            .unwrap();
    view.browser_state.panes = vec![browser::Choice {
        id: "pane-a".into(),
        label: "pane-a".into(),
        pane_count: None,
        window_id: Some("window".into()),
        browser_icon: None,
        display_name_source: None,
        window_label: None,
    }];
    view.browser_state.selected_pane = Some("pane-a".into());
    let doc =
        (status == Status::Ready).then(|| Arc::new(bezel_markdown::parse("# Notes\n\nbody\n")));
    view.browser_state.readers.insert(
        "pane-a".into(),
        Arc::new(Published {
            name: "notes.md".into(),
            folder: "docs".into(),
            status,
            doc,
            lossy: false,
            generation: 1,
        }),
    );
    view.input_geometry = Some((
        Bounds::new(point(px(0.), px(0.)), size(px(500.), px(500.))),
        Bounds::default(),
    ));
    view.input_cell_width = Some(10.);
    view.painted_frame = view.frame.clone();
    view.terminal_click(
        &MouseDownEvent {
            position: view.test_cell_point(0.5, 0.25),
            button: MouseButton::Left,
            ..Default::default()
        },
        window,
        cx,
    );
}

/// What reached the pane's terminal after `keys` (resizes are not input).
fn sent(cx: &mut TestAppContext, status: Status, keys: &str) -> Vec<String> {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        crate::tmux_snapshot::fit_test_support::fixture_view(
            window,
            cx,
            sender,
            7,
            browser::State {
                surface: browser::Surface::Workspace,
                ..Default::default()
            },
        )
    });
    cx.update(|window, cx| view.update(cx, |view, cx| setup(view, window, cx, status)));
    cx.update(|_, cx| cx.write_to_clipboard(ClipboardItem::new_string("rm -rf x".into())));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            assert!(view.terminal_focus.is_focused(window))
        })
    });
    cx.simulate_keystrokes(keys);
    // IME text and a committed composition go through the input handler.
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            use gpui::EntityInputHandler as _;
            view.replace_and_mark_text_in_range(None, "か", None, window, cx);
            view.replace_text_in_range(None, "漢字", window, cx);
        })
    });
    receiver
        .try_iter()
        .filter_map(|c| match c {
            browser::Command::Input { input, .. } if !matches!(input, Input::Resize { .. }) => {
                Some(format!("{input:?}"))
            }
            _ => None,
        })
        .collect()
}

const KEYS: [&str; 14] = [
    "down",
    "up",
    "enter",
    "escape",
    "ctrl-c",
    "q",
    "space",
    "pagedown",
    "backspace",
    "tab",
    "cmd-v",
    "home",
    "alt-b",
    "ctrl-d",
];

#[gpui::test]
fn no_key_paste_or_ime_text_reaches_the_pane_in_any_reader_state(cx: &mut TestAppContext) {
    for status in [
        Status::Ready,
        Status::Loading,
        Status::TooLarge(5 << 20),
        Status::Missing,
    ] {
        for keys in KEYS {
            assert_eq!(
                sent(cx, status.clone(), keys),
                Vec::<String>::new(),
                "{status:?} {keys}"
            );
        }
    }
}

/// A reader whose reads failed shows the pane's terminal again, and its keys
/// go there as for any pane.
#[gpui::test]
fn a_reader_that_shows_its_terminal_passes_keys_through(cx: &mut TestAppContext) {
    assert!(!sent(cx, Status::Unavailable, "q").is_empty());
}

#[gpui::test]
fn cmd_f_opens_find_on_a_shown_reader(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        crate::tmux_snapshot::fit_test_support::fixture_view(
            window,
            cx,
            sender,
            7,
            browser::State {
                surface: browser::Surface::Workspace,
                ..Default::default()
            },
        )
    });
    cx.update(|window, cx| view.update(cx, |view, cx| setup(view, window, cx, Status::Ready)));
    cx.simulate_keystrokes("cmd-f");
    view.read_with(cx, |view, _| assert!(view.reader_find_open()));
}

/// Each layer on its own (mutants K1, K2 and R26): the reader takes every key
/// itself, before terminal input is even tried, and the text input handler
/// refuses text while a reader owns the pane.
#[gpui::test]
fn the_reader_takes_each_key_itself_and_refuses_text(cx: &mut TestAppContext) {
    for status in [Status::Ready, Status::Loading] {
        let (sender, _receiver) = mpsc::sync_channel(64);
        let (view, cx) = cx.add_window_view(|window, cx| {
            crate::tmux_snapshot::fit_test_support::fixture_view(
                window,
                cx,
                sender,
                7,
                browser::State {
                    surface: browser::Surface::Workspace,
                    ..Default::default()
                },
            )
        });
        cx.update(|window, cx| view.update(cx, |view, cx| setup(view, window, cx, status.clone())));
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                assert!(view.reader_owns_input());
                for keys in KEYS {
                    let event = crate::tmux_snapshot::fit_test_support::key_down(keys);
                    assert!(view.reader_key(&event, window, cx), "{status:?} {keys}");
                }
                assert!(!view.accepts_text(window, cx), "{status:?}");
            })
        });
    }
}

/// What one keystroke did: picker open, sidebar hidden, terminal focused,
/// commands that are not pane input, and the pane input sent.
type Effect = (bool, bool, bool, usize, Vec<String>);

fn effect(cx: &mut TestAppContext, reader: bool, keys: &str) -> (Effect, Effect) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        crate::tmux_snapshot::fit_test_support::fixture_view(
            window,
            cx,
            sender,
            7,
            browser::State {
                surface: browser::Surface::Workspace,
                ..Default::default()
            },
        )
    });
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            setup(view, window, cx, Status::Ready);
            if !reader {
                view.browser_state.readers.clear();
            }
        })
    });
    receiver.try_iter().for_each(drop);
    let state = |cx: &mut VisualTestContext, receiver: &mpsc::Receiver<browser::Command>| {
        let (mut other, mut input) = (0, Vec::new());
        for command in receiver.try_iter() {
            match command {
                browser::Command::Input { input: i, .. } if !matches!(i, Input::Resize { .. }) => {
                    input.push(format!("{i:?}"))
                }
                _ => other += 1,
            }
        }
        cx.update(|window, cx| {
            view.read_with(cx, |v, _| {
                (
                    v.picker.is_some(),
                    v.sidebar_hidden,
                    v.terminal_focus.is_focused(window),
                    other,
                    input,
                )
            })
        })
    };
    let before = state(cx, &receiver);
    cx.simulate_keystrokes(keys);
    (before, state(cx, &receiver))
}

/// #756 review round 2, item 1: the app's own shortcuts (F-keys, Ctrl-G) act
/// from a reader pane exactly as from a terminal pane, and the reader's
/// process still gets nothing.
#[gpui::test]
fn app_shortcuts_work_from_a_reader_pane(cx: &mut TestAppContext) {
    for keys in [
        "f1", "f2", "f5", "f6", "f7", "f8", "f9", "f10", "ctrl-g", "cmd-k",
    ] {
        let control = effect(cx, false, keys);
        let reader = effect(cx, true, keys);
        assert!(reader.1.4.is_empty(), "{keys}: {:?}", reader.1.4);
        assert_eq!(reader, control, "{keys}");
    }
    // The comparison means something: these keys visibly act without a reader.
    for keys in ["f1", "f5", "f6", "f7", "f10", "ctrl-g"] {
        let (before, after) = effect(cx, true, keys);
        assert_ne!(before, after, "{keys} did nothing from a reader pane");
    }
}
