#![allow(clippy::unwrap_used)]

use super::HerdrWindow;
use crate::{
    WINDOW_TITLE,
    controls::Command,
    sidebar::layout_tests::{fixture_window, snapshot},
};
use std::sync::Arc;

fn main_windows(cx: &mut gpui::App) -> Vec<gpui::WindowHandle<HerdrWindow>> {
    cx.windows()
        .iter()
        .filter_map(gpui::AnyWindowHandle::downcast::<HerdrWindow>)
        .collect()
}

#[gpui::test]
fn new_window_adds_one_client_of_the_same_target_without_disturbing_the_first(
    cx: &mut gpui::TestAppContext,
) {
    let (view, cx) = cx.add_window_view(fixture_window);
    let target = view.update(cx, |view, _| view.endpoints[0].connection.target.clone());
    let before = cx.update(|_, cx| main_windows(cx));
    assert_eq!(before.len(), 1);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| view.command(Command::NewWindow, window, cx));
    });
    cx.run_until_parked();
    let opened = cx.update(|_, cx| main_windows(cx));
    assert_eq!(opened.len(), 2, "one more window onto the same daemon");
    let second = opened
        .into_iter()
        .find(|handle| !before.contains(handle))
        .unwrap();
    let first_inbox = view.update(cx, |view, _| view.endpoints[0].connection.inbox.clone());
    cx.update(|_, cx| {
        // The new window is a separate client: its own endpoint and inbox.
        second
            .update(cx, |second, _, _| {
                assert_eq!(second.endpoints.len(), 1);
                assert_eq!(second.endpoints[0].connection.target, target);
                assert!(!Arc::ptr_eq(
                    &second.endpoints[0].connection.inbox,
                    &first_inbox
                ));
            })
            .unwrap();
    });
    // The originating window keeps its own selection and error state.
    view.read_with(cx, |view, _| {
        assert_eq!(view.selected_endpoint, 0);
        assert!(view.local_error.is_none());
    });
}

#[gpui::test]
fn window_title_follows_the_focused_space_of_that_window(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            let mut snapshot = snapshot(4);
            snapshot.focused_workspace_id = Some("w0".into());
            view.live.snapshot = Some(Arc::new(snapshot));
        });
        view.update(cx, |view, _| view.sync_window_title(window));
    });
    assert_eq!(
        view.read_with(cx, |view, _| view.title.clone()),
        format!("{WINDOW_TITLE} \u{2014} herdr")
    );
    // An unknown focus falls back to the bare product name.
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            view.live.snapshot = None;
            view.sync_window_title(window);
        });
    });
    assert_eq!(
        view.read_with(cx, |view, _| view.title.clone()),
        WINDOW_TITLE
    );
}

#[gpui::test]
fn the_sidebar_gap_narrows_the_terminal_only_while_the_sidebar_shows(
    cx: &mut gpui::TestAppContext,
) {
    use gpui::{px, size};

    let (view, cx) = cx.add_window_view(fixture_window);
    cx.simulate_resize(size(px(900.), px(600.)));
    let draw = |cx: &mut gpui::VisualTestContext| {
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear(cx);
        });
    };
    let set_gap = |cx: &mut gpui::VisualTestContext, gap: f32, visible: bool| {
        cx.update(|_, cx| {
            view.update(cx, |view, cx| {
                view.config.layout.sidebar_gap = gap;
                view.sidebar_visible = visible;
                cx.notify();
            });
        });
    };

    // The shipped default puts the first column against the divider.
    draw(cx);
    let sidebar = cx.debug_bounds("sidebar").unwrap();
    assert_eq!(
        view.read_with(cx, |view, _| view.bounds.origin.x),
        sidebar.right(),
    );

    set_gap(cx, 0., true);
    draw(cx);
    let flush = view.read_with(cx, |view, _| view.bounds);
    assert_eq!(cx.debug_bounds("sidebar").unwrap(), sidebar);
    assert_eq!(flush.origin.x, sidebar.right());

    set_gap(cx, 16., true);
    draw(cx);
    let padded = view.read_with(cx, |view, _| view.bounds);
    // The same bounds feed painting, hit testing, and the resize the daemon
    // sees, so the gap must come out of the terminal's own width.
    assert_eq!(padded.origin.x, flush.origin.x + px(16.));
    assert_eq!(padded.size.width, flush.size.width - px(16.));
    assert_eq!(padded.size.height, flush.size.height);
    assert_eq!(cx.debug_bounds("sidebar").unwrap(), sidebar);

    // The compact rail keeps the gap beside its narrower column.
    set_gap(cx, 16., false);
    draw(cx);
    let rail = cx.debug_bounds("sidebar-rail").unwrap();
    let railed = view.read_with(cx, |view, _| view.bounds);
    assert_eq!(railed.origin.x, rail.right() + px(16.));
    assert_eq!(
        railed.size.width,
        flush.size.width + sidebar.size.width - rail.size.width - px(16.)
    );

    // Hiding the sidebar leaves nothing to separate the terminal from.
    cx.update(|_, cx| {
        view.update(cx, |view, _| {
            view.settings.shared = Some(
                crate::herdr_settings::Settings::parse_text(
                    "[ui]\nsidebar_collapsed_mode = 'hidden'\n",
                )
                .unwrap(),
            );
        });
    });
    set_gap(cx, 16., false);
    draw(cx);
    let hidden = view.read_with(cx, |view, _| view.bounds);
    assert_eq!(hidden.origin.x, px(0.));
    assert_eq!(hidden.size.width, flush.size.width + sidebar.size.width);
}

#[gpui::test]
fn a_held_key_repeats_in_the_terminal_but_keeps_accents_in_menus(cx: &mut gpui::TestAppContext) {
    use crate::input::TerminalInputHandler;
    use gpui::{Bounds, InputHandler};

    let (view, _) = cx.add_window_view(fixture_window);
    // macOS sends a held key's repeats only when press-and-hold is off.
    let mut terminal = TerminalInputHandler::new(Bounds::default(), view.clone(), false);
    assert!(!terminal.apple_press_and_hold_enabled());
    let mut menu = TerminalInputHandler::new(Bounds::default(), view, true);
    assert!(menu.apple_press_and_hold_enabled());
}

/// The window reports its terminal theme to each connection once it has a
/// snapshot, then only what a theme change altered, and a replacement
/// connection hears all of it again.
#[gpui::test]
fn host_theme_reaches_each_connection_and_follows_theme_changes(cx: &mut gpui::TestAppContext) {
    use gpui::AppContext;
    use herdr_client::{
        ConnectOptions, ConnectTarget, Stream, connect_with_connector,
        protocol::{endpoint::*, *},
    };
    use std::time::Duration;

    fn connect() -> (herdr_client::Client, Stream, Vec<herdr_client::ClientEvent>) {
        let (stream, mut server) = Stream::pair().unwrap();
        server
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let client = connect_with_connector(
            ConnectTarget::Socket("/unused".into()),
            ConnectOptions::default(),
            true,
            move |_, _| Ok(stream),
        )
        .unwrap();
        assert!(matches!(
            read_message(&mut server, MAX_FRAME_SIZE).unwrap(),
            ClientMessage::EndpointControl { .. }
        ));
        for (kind, data) in [
            (
                ENDPOINT_WELCOME_KIND,
                include_str!("../../../herdr-protocol/tests/fixtures/endpoint-welcome-v1.json"),
            ),
            (
                ENDPOINT_SNAPSHOT_KIND,
                include_str!("../../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"),
            ),
        ] {
            write_message(
                &mut server,
                &ServerMessage::EndpointControl {
                    kind: kind.into(),
                    data: data.into(),
                },
                MAX_GRAPHICS_FRAME_SIZE,
            )
            .unwrap();
        }
        let events = (0..2)
            .map(|_| client.events.recv_timeout(Duration::from_secs(3)).unwrap())
            .collect();
        (client, server, events)
    }
    fn theme_updates(server: &mut Stream, count: usize) -> Vec<ClientHostThemeUpdate> {
        (0..count)
            .map(|_| match read_message(server, MAX_FRAME_SIZE).unwrap() {
                ClientMessage::ClientShellHostTheme { update } => update,
                other => panic!("expected host theme, got {other:?}"),
            })
            .collect()
    }
    /// Nothing else was queued before this marker.
    fn assert_quiet(client: &herdr_client::Client, server: &mut Stream) {
        client.handle.set_focus("boot-v1", true).unwrap();
        assert_eq!(
            read_message::<_, ClientMessage>(server, MAX_FRAME_SIZE).unwrap(),
            ClientMessage::ClientShellFocus { focused: true }
        );
    }

    // No terminal render tree: it would enqueue unrelated resize requests.
    struct Fixture(gpui::Entity<HerdrWindow>);
    impl gpui::Render for Fixture {
        fn render(
            &mut self,
            _: &mut gpui::Window,
            _: &mut gpui::Context<Self>,
        ) -> impl gpui::IntoElement {
            gpui::div()
        }
    }
    let (fixture, cx) =
        cx.add_window_view(|window, cx| Fixture(cx.new(|cx| fixture_window(window, cx))));
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    let attach = |cx: &mut gpui::VisualTestContext, client: &herdr_client::Client, events| {
        cx.update(|_, cx| {
            view.update(cx, |view, cx| {
                let mut live = crate::state::LiveState::default();
                for event in events {
                    live.apply(event);
                }
                view.endpoints[0].live = live;
                view.endpoints[0].connection.handle = Some(client.handle.clone());
                cx.notify();
            });
        });
    };
    let expected = |cx: &mut gpui::VisualTestContext| {
        cx.update(|_, cx| {
            let light = matches!(
                cx.window_appearance(),
                gpui::WindowAppearance::Light | gpui::WindowAppearance::VibrantLight
            );
            crate::connection::host_theme(&view.read(cx).theme, light)
        })
    };

    let (client, mut server, events) = connect();
    attach(cx, &client, events);
    let theme = expected(cx);
    assert_eq!(
        theme.foreground,
        ClientHostColor {
            r: 0xd8,
            g: 0xde,
            b: 0xe9
        }
    );
    assert_eq!(
        theme.palette[1],
        ClientHostColor {
            r: 0x80,
            g: 0,
            b: 0
        }
    );
    let first = theme_updates(&mut server, 4);
    assert!(matches!(first[0], ClientHostThemeUpdate::Appearance(_)));
    assert!(matches!(&first[3], ClientHostThemeUpdate::PaletteColors(p) if p.len() == 256));
    // Further notifications with the same theme send nothing.
    cx.update(|_, cx| view.update(cx, |_, cx| cx.notify()));
    assert_quiet(&client, &mut server);

    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.theme.background = 0x123456;
            cx.notify();
        });
    });
    assert_eq!(
        theme_updates(&mut server, 1),
        [ClientHostThemeUpdate::DefaultColor {
            kind: ClientHostDefaultColorKind::Background,
            color: ClientHostColor {
                r: 0x12,
                g: 0x34,
                b: 0x56
            },
        }]
    );
    assert_quiet(&client, &mut server);

    // A reconnect is a new client: it is told the whole current theme.
    let (replacement, mut replacement_server, events) = connect();
    attach(cx, &replacement, events);
    let theme = expected(cx);
    assert_eq!(
        theme.background,
        ClientHostColor {
            r: 0x12,
            g: 0x34,
            b: 0x56
        }
    );
    assert_eq!(theme_updates(&mut replacement_server, 4).len(), 4);
    assert_quiet(&replacement, &mut replacement_server);
}
