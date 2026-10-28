#![allow(clippy::unwrap_used)]

use super::*;
use crate::{sidebar::layout_tests::fixture_window, state::ConnectionStatus};
use gpui::{AppContext, Bounds, point, prelude::*, px, size};
use herdr_client::protocol::{
    ClientShellPopupSurface, FrameData, PaneSurfaceFrame, PaneSurfacePane, SurfaceRect,
};
use std::sync::Arc;

#[test]
fn quotes_shell_metacharacters_apostrophes_and_unicode_without_execution() {
    let paths = [
        "/tmp/a b",
        "/tmp/it's",
        "/tmp/$(touch bad);`echo bad`&|<>*?[]{}!~$HOME\\\"",
        "/tmp/\u{65e5}\u{672c}\u{8a9e}",
    ]
    .map(PathBuf::from);
    assert_eq!(
        quote_paths(&paths).unwrap(),
        "'/tmp/a b' '/tmp/it'\\''s' '/tmp/$(touch bad);`echo bad`&|<>*?[]{}!~$HOME\\\"' '/tmp/\u{65e5}\u{672c}\u{8a9e}'"
    );
}

#[test]
fn rejects_control_characters_atomically_and_redacts_paths() {
    for control in [
        '\0', '\n', '\r', '\t', '\u{1b}', '\u{7f}', '\u{85}', '\u{9b}',
    ] {
        let error = quote_paths(&[
            PathBuf::from("/valid"),
            PathBuf::from(format!("/private{control}path")),
        ])
        .unwrap_err();
        assert!(matches!(error, Error::FileDropControl));
        assert!(!format!("{error} {error:?}").contains("private"));
    }
}

#[test]
fn bounds_path_count_and_expanded_utf8_bytes() {
    assert!(quote_paths(&vec![PathBuf::from("x"); MAX_PATHS]).is_ok());
    assert!(matches!(
        quote_paths(&vec![PathBuf::from("x"); MAX_PATHS + 1]),
        Err(Error::FileDropSize)
    ));
    let text = "x".repeat(MAX_PASTE_BYTES - 2);
    assert_eq!(quote_paths(&[text.into()]).unwrap().len(), MAX_PASTE_BYTES);
    for text in [
        "x".repeat(MAX_PASTE_BYTES - 1),
        "'".repeat(MAX_PASTE_BYTES / 4),
        "\u{e9}".repeat(MAX_PASTE_BYTES / 2),
        "x".repeat(MAX_PASTE_BYTES + 1),
    ] {
        assert!(matches!(
            quote_paths(&[text.into()]),
            Err(Error::FileDropSize)
        ));
    }
    assert!(matches!(
        quote_paths(&["x".repeat(MAX_PASTE_BYTES - 4).into(), "y".into()]),
        Err(Error::FileDropSize)
    ));
}

#[test]
fn empty_drop_is_no_text_but_empty_path_is_invalid() {
    assert_eq!(quote_paths(&[]).unwrap(), "");
    assert!(matches!(
        quote_paths(&[PathBuf::new()]),
        Err(Error::FileDropEmptyPath)
    ));
}

#[cfg(unix)]
#[test]
fn rejects_non_utf8_instead_of_lossy_replacement() {
    use std::{ffi::OsString, os::unix::ffi::OsStringExt};
    let path = PathBuf::from(OsString::from_vec(b"/private/\xff".to_vec()));
    let error = quote_paths(&[path]).unwrap_err();
    assert!(matches!(error, Error::FileDropEncoding));
    assert!(!format!("{error} {error:?}").contains("private"));
}

fn prepare(view: &mut HerdrWindow, cx: &mut Context<HerdrWindow>) {
    // Reconnect only to the fixture's explicit nonexistent socket, never a
    // personal daemon. The projection below is entirely synthetic.
    view.reconnect(cx);
    let snapshot = crate::sidebar::layout_tests::snapshot(2);
    let frame = FrameData {
        width: 80,
        height: 24,
        cells: vec![],
        cursor: None,
        hyperlinks: vec![],
        graphics: vec![],
    };
    view.options.surface_size.cols = frame.width;
    view.options.surface_size.rows = frame.height;
    view.live.surface = Some(Arc::new(PaneSurfaceFrame {
        boot_id: snapshot.boot_id.clone(),
        projection_revision: snapshot.revision,
        surface_revision: 1,
        frame,
        panes: [0, 40]
            .into_iter()
            .map(|x| PaneSurfacePane {
                pane_id: format!("pane-{x}"),
                content_revision: 1,
                rect: SurfaceRect {
                    x,
                    y: 0,
                    width: 40,
                    height: 24,
                },
                inner_rect: SurfaceRect {
                    x: x + 1,
                    y: 1,
                    width: 38,
                    height: 22,
                },
                scrollbar_rect: None,
                scroll: None,
                focused: x == 0,
                mouse_reporting: false,
                sgr_pixel_mouse: false,
                alternate_screen_active: false,
                pixel_width: 380,
                pixel_height: 440,
            })
            .collect(),
        splits: vec![],
        popup: None,
        graphics: Default::default(),
    }));
    view.live.snapshot = Some(Arc::new(snapshot));
    view.live.status = ConnectionStatus::Connected;
    view.cell_width = 10.;
    view.bounds = Bounds::new(
        point(px(100.), px(50.)),
        size(px(800.), px(24. * view.config.terminal.line_height())),
    );
    assert!(view.input_ready());
}

struct DropFixture {
    view: gpui::Entity<HerdrWindow>,
    submitted_at: Option<Point<Pixels>>,
}

impl Render for DropFixture {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        gpui::div()
            .size_full()
            .on_drop(cx.listener(|this, paths: &ExternalPaths, window, cx| {
                this.submitted_at = Some(window.mouse_position());
                this.view.update(cx, |view, cx| {
                    view.drop_terminal_files(paths, window, cx);
                });
            }))
    }
}

#[gpui::test]
fn external_drop_dispatches_with_submit_position_and_empty_payload_is_inert(
    cx: &mut gpui::TestAppContext,
) {
    // GPUI 0.2.2 exposes only Default for ExternalPaths construction; its
    // populated constructor is platform-private. Exercise actual dispatch
    // with an empty payload, and populated formatting separately above.
    let (fixture, cx) = cx.add_window_view(|window, cx| DropFixture {
        view: cx.new(|cx| {
            let mut view = fixture_window(window, cx);
            prepare(&mut view, cx);
            view
        }),
        submitted_at: None,
    });
    cx.update(|window, cx| {
        cx.write_to_clipboard(gpui::ClipboardItem::new_string("unchanged".into()));
        window.refresh();
        window.draw(cx).clear(cx);
    });
    let entered = point(px(120.), px(100.));
    let submitted = point(px(520.), px(100.));
    cx.simulate_event(gpui::FileDropEvent::Entered {
        position: entered,
        paths: ExternalPaths::default(),
    });
    cx.simulate_event(gpui::FileDropEvent::Submit {
        position: submitted,
    });
    fixture.read_with(cx, |fixture, cx| {
        assert_eq!(fixture.submitted_at, Some(submitted));
        assert!(fixture.view.read(cx).local_error.is_none());
    });
    assert_eq!(
        cx.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text())),
        Some("unchanged".into())
    );
}

#[gpui::test]
fn targets_drop_position_not_focus_and_never_targets_chrome_or_covered_panes(
    cx: &mut gpui::TestAppContext,
) {
    let (view, cx) = cx.add_window_view(fixture_window);
    view.update(cx, |view, cx| {
        prepare(view, cx);
        let at = |column: f32, row: f32| {
            point(
                px(100. + column * 10.),
                px(50. + row * view.config.terminal.line_height()),
            )
        };
        assert_eq!(
            view.file_drop_target(at(42., 2.)),
            Some(InputTarget::Pane("pane-40".into()))
        );
        for position in [
            at(-1., 2.),
            at(0., 2.),
            at(40., 2.),
            at(42., 0.),
            at(81., 2.),
        ] {
            assert_eq!(view.file_drop_target(position), None);
        }
        let outside_popup = at(2., 2.);
        let inside_popup = at(32., 9.);
        let surface = Arc::make_mut(view.live.surface.as_mut().unwrap());
        surface.popup = Some(Box::new(ClientShellPopupSurface {
            terminal_id: "popup".into(),
            title: String::new(),
            width: None,
            height: None,
            frame: FrameData {
                width: 20,
                height: 10,
                ..surface.frame.clone()
            },
            mouse_reporting: false,
            sgr_pixel_mouse: false,
            pixel_width: 200,
            pixel_height: 200,
        }));
        assert_eq!(view.file_drop_target(outside_popup), None);
        assert_eq!(
            view.file_drop_target(inside_popup),
            Some(InputTarget::Popup("popup".into()))
        );
    });
}

#[gpui::test]
fn drops_obey_menu_readiness_and_projection_fences(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    view.update(cx, |view, cx| {
        prepare(view, cx);
        let position =
            view.bounds.origin + point(px(20.), px(2. * view.config.terminal.line_height()));
        assert!(view.file_drop_target(position).is_some());
        view.menu.page = Some(crate::menu::Page::Palette);
        assert_eq!(view.file_drop_target(position), None);
        view.menu.page = None;
        view.pending_toast = Some(1);
        assert_eq!(view.file_drop_target(position), None);
        view.pending_toast = None;
        view.options.surface_size.cols += 1;
        assert_eq!(view.file_drop_target(position), None);
        view.options.surface_size.cols -= 1;
        view.live.status = ConnectionStatus::Disconnected;
        assert_eq!(view.file_drop_target(position), None);
        view.live.status = ConnectionStatus::Connected;
        Arc::make_mut(view.live.surface.as_mut().unwrap()).projection_revision += 1;
        assert_eq!(view.file_drop_target(position), None);
        Arc::make_mut(view.live.surface.as_mut().unwrap()).projection_revision -= 1;
        Arc::make_mut(view.live.surface.as_mut().unwrap())
            .boot_id
            .push_str("-old");
        assert_eq!(view.file_drop_target(position), None);
    });
}
