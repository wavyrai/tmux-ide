use super::*;

#[test]
fn cursor_animation_is_on_unless_saved_off() -> anyhow::Result<()> {
    assert!(Setting::default().enabled);
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("gpui-cursor.json");
    let missing = Setting::load(Some(path.clone()));
    assert!(missing.enabled && missing.ready && missing.note.is_none());
    developer_mode::write(&path, false)?;
    assert!(!Setting::load(Some(path.clone())).enabled);
    developer_mode::write(&path, true)?;
    assert!(Setting::load(Some(path.clone())).enabled);
    std::fs::write(&path, "not json")?;
    let malformed = Setting::load(Some(path));
    assert!(malformed.enabled && malformed.note.is_some());
    Ok(())
}

#[test]
fn the_cursor_setting_has_its_own_file_and_temporary() -> anyhow::Result<()> {
    let dir = tempfile::tempdir()?;
    let developer = dir.path().join("gpui-developer.json");
    let cursor = dir.path().join("gpui-cursor.json");
    // A pending developer write does not block the cursor's.
    let temporary = dir
        .path()
        .join(format!(".gpui-developer-{}.tmp", std::process::id()));
    std::fs::write(&temporary, "pending")?;
    developer_mode::write(&cursor, false)?;
    assert!(!developer_mode::read(&cursor)?.enabled);
    assert!(developer_mode::read(&developer).is_err());
    Ok(())
}

mod view {
    #![allow(clippy::unwrap_used)]
    use super::super::super::{
        browser,
        decode::{MouseEncoding, MouseProtocol, PointerModes},
        fit_test_support::fixture_view,
    };
    use super::*;
    use core::prelude::v1::test;
    use gpui::{TestAppContext, VisualTestContext};
    use herdr_client::protocol::{CellData, CursorState, FrameData};
    use std::sync::{Arc, mpsc};

    /// One input of the view changed between two paints.
    #[derive(Clone, Copy, Debug)]
    enum Change {
        Nothing,
        Session,
        Pane,
        AlternateScreen,
        Scrollback,
        GridSize,
        ResizePreview,
        WindowFocus,
        ReduceMotion,
        SettingOff,
        HiddenBetween,
    }

    fn frame(x: u16, y: u16, visible: bool, (width, height): (u16, u16)) -> DisplayFrame {
        let blank = CellData {
            symbol: " ".into(),
            fg: 0,
            bg: 0,
            modifier: 0,
            skip: false,
            hyperlink: None,
        };
        Arc::new(FrameData {
            cells: vec![blank; usize::from(width) * usize::from(height)],
            width,
            height,
            cursor: Some(CursorState {
                x,
                y,
                visible,
                shape: 0,
            }),
            hyperlinks: vec![],
            graphics: vec![],
        })
        .into()
    }

    fn modes(alternate: bool) -> Option<PointerModes> {
        Some(PointerModes {
            protocol: MouseProtocol::Vt200,
            encoding: MouseEncoding::Sgr,
            alternate,
        })
    }

    /// Paints the cursor at (4, 2), applies `change`, then paints it one cell
    /// right, through the view's own `glide_cursor`. Returns where the painter
    /// draws the cursor on that second paint.
    fn second_paint(cx: &mut TestAppContext, change: Change) -> (f32, f32) {
        let (sender, _receiver) = mpsc::sync_channel(64);
        let (view, cx) = cx.add_window_view(|window, cx| {
            fixture_view(
                window,
                cx,
                sender,
                7,
                browser::State {
                    selected_session: Some("main".into()),
                    pointer_modes: modes(false),
                    ..Default::default()
                },
            )
        });
        let painter = RefCell::new(TerminalPainter::default());
        let paint = |cx: &mut VisualTestContext, frame: &DisplayFrame, preview: bool| {
            cx.update(|window, cx| {
                view.update(cx, |view, cx| {
                    view.glide_cursor(&painter, frame, &preview.then_some(()), window, cx)
                })
            });
        };
        let mut size = (80, 24);
        let mut preview = false;
        // A focused window with motion allowed (tests default to reduced).
        cx.update(|window, cx| {
            window.activate_window();
            view.update(cx, |v, cx| {
                v.chrome.force_motion(false);
                v.chrome.sync_motion(cx);
            })
        });
        cx.run_until_parked();
        cx.update(|window, _| assert!(window.is_window_active()));
        paint(cx, &frame(4, 2, true, size), false);
        match change {
            Change::Nothing => {}
            Change::Session => view.update(cx, |v, _| {
                v.browser_state.selected_session = Some("other".into())
            }),
            Change::Pane => view.update(cx, |v, _| {
                v.browser_state.selected_pane = Some("pane-b".into())
            }),
            Change::AlternateScreen => {
                view.update(cx, |v, _| v.browser_state.pointer_modes = modes(true))
            }
            Change::Scrollback => view.update(cx, |v, _| v.browser_state.history_offset = 3),
            Change::GridSize => size = (81, 24),
            Change::ResizePreview => preview = true,
            Change::WindowFocus => {
                cx.deactivate_window();
                cx.update(|window, _| assert!(!window.is_window_active()));
            }
            // As macOS reports it: the chrome hands the setting to gpui.
            Change::ReduceMotion => cx.update(|_, cx| {
                view.update(cx, |v, cx| {
                    v.chrome.force_motion(true);
                    v.chrome.sync_motion(cx);
                })
            }),
            Change::SettingOff => view.update(cx, |v, _| v.cursor_motion.enabled = false),
            Change::HiddenBetween => paint(cx, &frame(5, 2, false, size), false),
        }
        paint(cx, &frame(5, 2, true, size), preview);
        let drawn = painter
            .borrow()
            .cursor_glide
            .drawn(CursorCell { x: 5, y: 2 });
        (drawn.x, drawn.y)
    }

    #[gpui::test]
    fn a_one_cell_move_glides_in_the_view(cx: &mut TestAppContext) {
        let (x, y) = second_paint(cx, Change::Nothing);
        assert!(x > 4.5 && x < 5., "glides past half-way: {x}");
        assert_eq!(y, 2.);
    }

    #[test]
    fn each_scene_input_motion_preference_and_hidden_cursor_snaps() {
        for change in [
            Change::Session,
            Change::Pane,
            Change::AlternateScreen,
            Change::Scrollback,
            Change::GridSize,
            Change::ResizePreview,
            Change::WindowFocus,
            Change::ReduceMotion,
            Change::SettingOff,
            Change::HiddenBetween,
        ] {
            let mut cx = TestAppContext::single();
            assert_eq!(
                second_paint(&mut cx, change),
                (5., 2.),
                "{change:?} must snap"
            );
        }
    }

    #[gpui::test]
    fn the_target_drops_a_hidden_cursor_and_honours_motion_preferences(cx: &mut TestAppContext) {
        let (sender, _receiver) = mpsc::sync_channel(64);
        let (view, cx) = cx
            .add_window_view(|window, cx| fixture_view(window, cx, sender, 7, Default::default()));
        view.update(cx, |view, _| {
            let shown = frame(3, 1, true, (80, 24));
            let hidden = frame(3, 1, false, (80, 24));
            let outside = frame(80, 1, true, (80, 24));
            let on = target(view, shown.view(), false, true, false);
            assert_eq!(on.cell, Some(CursorCell { x: 3, y: 1 }));
            assert!(on.animate);
            assert_eq!(target(view, hidden.view(), false, true, false).cell, None);
            assert_eq!(target(view, outside.view(), false, true, false).cell, None);
            assert!(!target(view, shown.view(), false, true, true).animate);
            view.cursor_motion.enabled = false;
            assert!(!target(view, shown.view(), false, true, false).animate);
        });
    }
}
