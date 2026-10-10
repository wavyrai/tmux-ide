use super::*;

mod bold_color;
mod wheel;

#[test]
fn pane_context_hit_testing_uses_canvas_origin_and_rects_not_focus() {
    use herdr_client::protocol::*;
    let frame = FrameData {
        cells: vec![],
        width: 80,
        height: 24,
        cursor: None,
        hyperlinks: vec![],
        graphics: vec![],
    };
    let pane = PaneSurfacePane {
        pane_id: "left".into(),
        content_revision: 1,
        rect: SurfaceRect {
            x: 0,
            y: 0,
            width: 40,
            height: 24,
        },
        inner_rect: SurfaceRect {
            x: 1,
            y: 1,
            width: 38,
            height: 22,
        },
        scrollbar_rect: None,
        scroll: None,
        focused: true,
        mouse_reporting: false,
        sgr_pixel_mouse: false,
        alternate_screen_active: false,
        pixel_width: 380,
        pixel_height: 440,
    };
    let mut right = pane.clone();
    right.pane_id = "right".into();
    right.rect.x = 40;
    right.inner_rect.x = 41;
    right.focused = false;
    let mut surface = PaneSurfaceFrame {
        boot_id: "boot".into(),
        projection_revision: 1,
        surface_revision: 1,
        frame: frame.clone(),
        panes: vec![pane, right],
        splits: vec![],
        popup: None,
        graphics: Default::default(),
    };
    let origin = point(px(217.), px(93.));
    let bounds = Bounds::new(origin, size(px(700.), px(500.)));
    let hit = |surface: &PaneSurfaceFrame, x, y| {
        pane_at(surface, bounds, origin + point(px(x), px(y)), 8.5, 20.).map(str::to_owned)
    };
    // Border cells belong to the pane; the exact split edge belongs to its neighbor.
    assert_eq!(hit(&surface, 0., 0.).as_deref(), Some("left"));
    assert_eq!(hit(&surface, 339.9, 20.).as_deref(), Some("left"));
    assert_eq!(hit(&surface, 340., 20.).as_deref(), Some("right"));
    assert_eq!(hit(&surface, 679.9, 479.9).as_deref(), Some("right"));
    for (x, y) in [
        (-0.1, 20.),
        (10., -0.1),
        (680., 20.),
        (10., 480.),
        (f32::NAN, 20.),
        (10., f32::INFINITY),
    ] {
        assert!(hit(&surface, x, y).is_none());
    }
    for invalid in [0., -1., f32::NAN, f32::INFINITY] {
        assert!(pane_at(&surface, bounds, origin, invalid, 20.).is_none());
        assert!(pane_at(&surface, bounds, origin, 8.5, invalid).is_none());
    }
    let clipped = Bounds::new(origin, size(px(350.), px(300.)));
    assert!(
        pane_at(
            &surface,
            clipped,
            origin + point(px(351.), px(20.)),
            8.5,
            20.
        )
        .is_none()
    );
    surface.popup = Some(Box::new(ClientShellPopupSurface {
        terminal_id: "popup".into(),
        title: String::new(),
        width: None,
        height: None,
        frame: FrameData {
            width: 20,
            height: 10,
            ..frame
        },
        mouse_reporting: true,
        sgr_pixel_mouse: false,
        pixel_width: 170,
        pixel_height: 200,
    }));
    // Even outside the popup, covered panes must not receive context actions.
    assert!(hit(&surface, 0., 0.).is_none());
    assert!(hit(&surface, 400., 200.).is_none());
}

#[test]
fn wheel_hits_inner_pane_and_uses_relative_coordinates_and_semantic_modes() {
    use herdr_client::protocol::*;
    let frame = FrameData {
        cells: vec![],
        width: 80,
        height: 24,
        cursor: None,
        hyperlinks: vec![],
        graphics: vec![],
    };
    let mut surface = PaneSurfaceFrame {
        boot_id: "boot".into(),
        projection_revision: 1,
        surface_revision: 1,
        frame: frame.clone(),
        splits: vec![],
        popup: None,
        graphics: Default::default(),
        panes: vec![PaneSurfacePane {
            pane_id: "pane".into(),
            content_revision: 1,
            rect: SurfaceRect {
                x: 0,
                y: 0,
                width: 40,
                height: 24,
            },
            inner_rect: SurfaceRect {
                x: 1,
                y: 1,
                width: 38,
                height: 22,
            },
            scrollbar_rect: None,
            scroll: None,
            focused: false,
            mouse_reporting: false,
            sgr_pixel_mouse: false,
            alternate_screen_active: false,
            pixel_width: 380,
            pixel_height: 440,
        }],
    };
    assert!(wheel_target(&surface, -1., 25., 10., CELL_HEIGHT).is_none());
    assert!(wheel_target(&surface, 5., 25., 10., CELL_HEIGHT).is_none());
    assert!(wheel_target(&surface, 400., 25., 10., CELL_HEIGHT).is_none());
    for invalid in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY, 0., -1.] {
        assert!(wheel_target(&surface, 35., 65., invalid, CELL_HEIGHT).is_none());
        assert!(wheel_target(&surface, 35., 65., 10., invalid).is_none());
    }
    for alternate in [false, true] {
        surface.panes[0].alternate_screen_active = alternate;
        let target = wheel_target(&surface, 35., 65., 10., CELL_HEIGHT).unwrap();
        assert_eq!(target.target, InputTarget::Pane("pane".into()));
        assert_eq!(
            target.position,
            ClientMousePosition::Cell { column: 2, row: 2 }
        );
        assert!(matches!(
            target
                .wheel_events(
                    WheelSteps {
                        lines: -3,
                        columns: 0
                    },
                    Modifiers::default()
                )
                .next()
                .unwrap(),
            ClientPaneInputEvent::Mouse {
                kind: ClientMouseKind::ScrollDown,
                lines: 3,
                ..
            }
        ));
    }
    surface.panes[0].sgr_pixel_mouse = true;
    let target = wheel_target(&surface, 35., 65., 10., CELL_HEIGHT).unwrap();
    assert_eq!(
        target.position,
        ClientMousePosition::Pixels {
            x: 25,
            y: 45,
            column: 2,
            row: 2
        }
    );
    assert_eq!(target.geometry.unwrap().cols, 38);
    let target = wheel_target(&surface, 35., 97.5, 10., 30.).unwrap();
    assert_eq!(
        target.position,
        ClientMousePosition::Pixels {
            x: 25,
            y: 45,
            column: 2,
            row: 2,
        }
    );
    surface.popup = Some(Box::new(ClientShellPopupSurface {
        terminal_id: "popup".into(),
        title: String::new(),
        width: None,
        height: None,
        frame: FrameData {
            width: 20,
            height: 10,
            ..frame
        },
        mouse_reporting: true,
        sgr_pixel_mouse: false,
        pixel_width: 200,
        pixel_height: 200,
    }));
    assert!(wheel_target(&surface, 35., 65., 10., CELL_HEIGHT).is_none());
    let target = wheel_target(&surface, 315., 165., 10., CELL_HEIGHT).unwrap();
    assert_eq!(target.target, InputTarget::Popup("popup".into()));
    assert_eq!(
        target.position,
        ClientMousePosition::Cell { column: 1, row: 1 }
    );
    let target = wheel_target(&surface, 315., 247.5, 10., 30.).unwrap();
    assert_eq!(
        target.position,
        ClientMousePosition::Cell { column: 1, row: 1 }
    );

    let origin = point(px(17.), px(29.));
    let cursor = CursorState {
        x: 2,
        y: 3,
        visible: false,
        shape: 0,
    };
    surface.frame.cursor = Some(CursorState {
        x: 70,
        y: 20,
        ..cursor.clone()
    });
    surface.popup.as_mut().unwrap().frame.cursor = Some(cursor);
    // A hidden popup cursor still anchors IME; never use the base cursor.
    assert_eq!(
        input_cursor_bounds(Some(&surface), origin, 8.5, CELL_HEIGHT),
        Bounds::new(origin + point(px(272.), px(200.)), size(px(8.5), px(20.)))
    );
    assert_eq!(
        input_cursor_bounds(Some(&surface), origin, 8.5, 30.5),
        Bounds::new(origin + point(px(272.), px(305.)), size(px(8.5), px(30.5)))
    );
    surface.popup.as_mut().unwrap().frame.cursor = None;
    assert_eq!(
        input_cursor_bounds(Some(&surface), origin, 8.5, CELL_HEIGHT).origin,
        origin + point(px(255.), px(140.))
    );
    assert_eq!(
        input_cursor_bounds(Some(&surface), origin, 8.5, 30.5).origin,
        origin + point(px(255.), px(213.5))
    );
    let grid = Bounds::new(origin, size(px(680.), px(480.)));
    // A composition in a popup stays inside the popup, not the grid.
    assert_eq!(
        input_area(Some(&surface), grid, 8.5, CELL_HEIGHT),
        Bounds::new(origin + point(px(255.), px(140.)), size(px(170.), px(200.)))
    );
    surface.popup = None;
    assert_eq!(input_area(Some(&surface), grid, 8.5, CELL_HEIGHT), grid);
    assert_eq!(input_area(None, grid, 8.5, CELL_HEIGHT), grid);
    assert_eq!(
        input_cursor_bounds(Some(&surface), origin, 8.5, CELL_HEIGHT).origin,
        origin + point(px(595.), px(400.))
    );
    assert_eq!(
        input_cursor_bounds(Some(&surface), origin, 8.5, 30.5).origin,
        origin + point(px(595.), px(610.))
    );
    surface.frame.cursor = None;
    assert_eq!(
        input_cursor_bounds(Some(&surface), origin, 8.5, CELL_HEIGHT).origin,
        origin
    );
    assert_eq!(
        input_cursor_bounds(None, origin, 8.5, CELL_HEIGHT).origin,
        origin
    );
    for surface in [Some(&surface), None] {
        assert_eq!(
            input_cursor_bounds(surface, origin, 8.5, 30.5),
            Bounds::new(origin, size(px(8.5), px(30.5)))
        );
    }
}

#[test]
fn popup_origin_rounds_horizontal_pixels_and_saturates_oversized_frames() {
    let frame = FrameData {
        width: 81,
        height: 25,
        cells: vec![],
        cursor: None,
        hyperlinks: vec![],
        graphics: vec![],
    };
    let popup = FrameData {
        width: 20,
        height: 10,
        ..frame.clone()
    };
    assert_eq!(
        popup_origin(&frame, &popup, 8.5, CELL_HEIGHT),
        point(px(259.), px(150.))
    );
    assert_eq!(
        popup_origin(&popup, &frame, 8.5, CELL_HEIGHT),
        Point::default()
    );
    assert_eq!(
        popup_origin(&frame, &popup, 8.5, 30.5),
        point(px(259.), px(228.75))
    );
    assert_eq!(popup_origin(&popup, &frame, 8.5, 30.5), Point::default());
}

#[test]
fn wire_colors_are_not_argb() {
    let theme = Theme::default();
    assert_eq!(color(0, FOREGROUND, &theme), FOREGROUND);
    assert_eq!(color(0, BACKGROUND, &theme), BACKGROUND);
    for (i, expected) in theme.palette[..16].iter().enumerate() {
        assert_eq!(color(i as u32 + 1, 0, &theme), *expected);
        assert_eq!(color(0x01000000 | i as u32, 0, &theme), *expected);
    }
    assert_eq!(color(0x02123456, 0, &theme), 0x123456);
    assert_eq!(color(0x01000010, 1, &theme), 0);
    assert_eq!(color(0x01000015, 0, &theme), 0x0000ff);
    assert_eq!(color(0x010000e7, 0, &theme), 0xffffff);
    assert_eq!(color(0x010000e8, 0, &theme), 0x080808);
    assert_eq!(color(0x010000ff, 0, &theme), 0xeeeeee);
    assert_eq!(color(0xff000000, 42, &theme), 42);
}

#[test]
fn reverse_and_hidden_colors() {
    let mut cell = CellData {
        symbol: "x".into(),
        fg: 0x02ff0000,
        bg: 0x020000ff,
        modifier: 1 << 6,
        skip: false,
        hyperlink: None,
    };
    assert_eq!(cell_colors(&cell, &Theme::default()), (0x0000ff, 0xff0000));
    cell.modifier |= 1 << 7;
    assert_eq!(cell_colors(&cell, &Theme::default()), (0xff0000, 0xff0000));
}

#[test]
fn geometry_is_bounded_and_uses_terminal_viewport() {
    assert_eq!(
        viewport(800., 480., 10., CELL_HEIGHT),
        ClientSurfaceSize { cols: 80, rows: 24 }
    );
    assert_eq!(
        viewport(0., 0., 10., CELL_HEIGHT),
        ClientSurfaceSize { cols: 1, rows: 1 }
    );
    assert_eq!(
        viewport(800., 480., 12.5, 30.),
        ClientSurfaceSize { cols: 64, rows: 16 }
    );
    let huge = viewport(1e9, 1e9, 10., CELL_HEIGHT);
    assert!(u32::from(huge.cols) * u32::from(huge.rows) <= 1_000_000);
}

#[test]
fn custom_palette_and_defaults_preserve_truecolor_and_modifiers() {
    let mut theme = Theme {
        foreground: 0xabcdef,
        background: 0x123456,
        ..Theme::default()
    };
    for (i, entry) in theme.palette.iter_mut().enumerate() {
        *entry = 0x654300 + i as u32;
    }
    for i in 0..256 {
        assert_eq!(color(0x01000000 | i, 0, &theme), theme.palette[i as usize]);
        if i < 16 {
            assert_eq!(color(i + 1, 0, &theme), theme.palette[i as usize]);
        }
    }
    let mut cell = CellData {
        symbol: "x".into(),
        fg: 0,
        bg: 0,
        modifier: 0,
        skip: false,
        hyperlink: None,
    };
    assert_eq!(
        cell_colors(&cell, &theme),
        (theme.foreground, theme.background)
    );
    cell.fg = 0x02123456;
    cell.bg = 0x010000ff;
    assert_eq!(cell_colors(&cell, &theme), (0x123456, theme.palette[255]));
    cell.modifier = 1 << 6;
    assert_eq!(cell_colors(&cell, &theme), (theme.palette[255], 0x123456));
    cell.modifier |= 1 << 1;
    assert_eq!(
        cell_colors(&cell, &theme).0,
        ((theme.palette[255] & 0xfefefe) >> 1) + ((0x123456 & 0xfefefe) >> 1)
    );
}

#[test]
fn held_keys_release_what_was_pressed_only_under_report_all() {
    let press = |s: &str| {
        key_input(
            &KeyDownEvent {
                keystroke: Keystroke::parse(s).unwrap(),
                is_held: true,
                prefer_character_input: false,
            },
            false,
        )
        .unwrap()
    };
    let mut held = HeldKeys::default();
    assert_eq!(held.press("left", press("left"), false), press("left"));
    assert_eq!(held.release("left"), None);

    let sent = held.press("c", press("ctrl-c"), true);
    let ClientPaneInputEvent::Key {
        kind: ClientKeyKind::Repeat,
        tracks_release: true,
        ..
    } = sent
    else {
        panic!("a held press keeps its kind and tracks its release: {sent:?}");
    };
    let Some(ClientPaneInputEvent::Key {
        code: ClientKeyCode::Char('c'),
        modifiers: 2,
        kind: ClientKeyKind::Release,
        repeat_count: 1,
        tracks_release: true,
        ..
    }) = held.release("c")
    else {
        panic!("the release repeats the press's key and modifiers");
    };
    assert_eq!(held.release("c"), None);

    held.press("up", press("up"), true);
    held.forget("up");
    assert_eq!(held.release("up"), None);

    // Key-ups lost to a focus change cannot grow it without bound.
    for n in 1..=24 {
        let key = format!("f{n}");
        held.press(&key, press(&key), true);
    }
    assert_eq!(held.0.len(), HeldKeys::LIMIT);
    assert_eq!(held.release("f1"), None);
    assert!(held.release("f24").is_some());
}

#[test]
fn special_keys_and_text_are_separate() {
    let key = |s| Keystroke::parse(s).unwrap();
    for alt_keys in [false, true] {
        let code = |s| key_code(&key(s), alt_keys);
        assert_eq!(code("ctrl-c"), Some(ClientKeyCode::Char('c')));
        assert_eq!(code("shift-tab"), Some(ClientKeyCode::BackTab));
        assert_eq!(code("alt-left"), Some(ClientKeyCode::Left));
        assert_eq!(code("f12"), Some(ClientKeyCode::F(12)));
        assert_eq!(code("a"), None);
        assert_eq!(code("shift-a"), None);
        assert_eq!(code("cmd-q"), None);
        assert_eq!(code("cmd-alt-p"), None);
    }
    assert_eq!(key_code(&key("alt-e"), false), None);
    assert_eq!(key_code(&key("alt-space"), false), None);
}

#[test]
fn a_pane_key_sends_its_target_held_as_typed() {
    let typed = KeyDownEvent {
        keystroke: Keystroke::parse("cmd-left").unwrap(),
        is_held: true,
        prefer_character_input: false,
    };
    assert_eq!(key_input(&typed, true), None);
    let Some(ClientPaneInputEvent::Key {
        code,
        modifiers,
        kind,
        ..
    }) = pane_key_input(&typed, &Keystroke::parse("ctrl-a").unwrap())
    else {
        panic!("no key sent");
    };
    assert_eq!(
        (code, modifiers, kind),
        (ClientKeyCode::Char('a'), 2, ClientKeyKind::Repeat)
    );
    // Alt-modified targets are sent whatever option_as_alt says.
    assert!(reaches_pane(&Keystroke::parse("alt-b").unwrap()));
    for unsendable in ["cmd-a", "a", "shift-a"] {
        assert!(
            !reaches_pane(&Keystroke::parse(unsendable).unwrap()),
            "{unsendable}"
        );
    }
}

#[test]
fn alt_characters_reach_the_pane_as_shortcuts() {
    let alt = |s| {
        key_input(
            &KeyDownEvent {
                keystroke: Keystroke::parse(s).unwrap(),
                is_held: false,
                prefer_character_input: false,
            },
            true,
        )
    };
    for (keystroke, ch, modifiers) in [
        ("alt-p", 'p', 4),
        ("alt-shift-p", 'P', 5),
        ("alt-1", '1', 4),
        ("alt-.", '.', 4),
        ("alt-space", ' ', 4),
        ("ctrl-alt-p", 'p', 6),
    ] {
        let Some(ClientPaneInputEvent::Key {
            code,
            modifiers: sent,
            ..
        }) = alt(keystroke)
        else {
            panic!("{keystroke} should be a key");
        };
        assert_eq!(
            (code, sent),
            (ClientKeyCode::Char(ch), modifiers),
            "{keystroke}"
        );
    }
}

#[test]
fn option_as_alt_follows_the_layout_only_on_macos() {
    use crate::config::{OptionAsAlt, OptionKeys};
    let us = "com.apple.keylayout.US";
    let german = "com.apple.keylayout.German";
    let macos = cfg!(target_os = "macos");
    let left = OptionKeys::LEFT;
    assert!(OptionAsAlt::Auto.sends_alt(us, left));
    assert!(OptionAsAlt::Auto.sends_alt("com.apple.keylayout.ABC", left));
    assert_eq!(OptionAsAlt::Auto.sends_alt(german, left), !macos);
    assert!(OptionAsAlt::Always.sends_alt(german, left));
    assert_eq!(OptionAsAlt::Never.sends_alt(us, left), !macos);
}

#[test]
fn the_right_option_types_dead_keys_while_the_left_sends_alt() {
    use crate::config::{OptionAsAlt, OptionKeys};
    let us = "com.apple.keylayout.US";
    let macos = cfg!(target_os = "macos");
    let right = OptionKeys {
        left: false,
        right: true,
    };
    let both = OptionKeys {
        left: true,
        right: true,
    };
    assert_eq!(OptionAsAlt::Auto.sends_alt(us, right), !macos);
    assert!(OptionAsAlt::Auto.sends_alt(us, both));
    assert!(OptionAsAlt::Left.sends_alt("com.apple.keylayout.German", OptionKeys::LEFT));
    assert_eq!(OptionAsAlt::Left.sends_alt(us, right), !macos);
    assert!(OptionAsAlt::Right.sends_alt(us, right));
    assert_eq!(OptionAsAlt::Right.sends_alt(us, OptionKeys::LEFT), !macos);
    assert!(OptionAsAlt::Always.sends_alt(us, right));
    // NSEvent's device-dependent bits: left 0x20, right 0x40, with the
    // device-independent Option flag 0x80000 beside them.
    assert_eq!(OptionKeys::from_device_flags(0x80020), OptionKeys::LEFT);
    assert_eq!(OptionKeys::from_device_flags(0x80040), right);
    assert_eq!(OptionKeys::from_device_flags(0x80060), both);
    // A synthesized event without the bits counts as the left key.
    assert_eq!(OptionKeys::from_device_flags(0x80000), OptionKeys::LEFT);
}

#[test]
fn scrollbar_thumb_tracks_offset_to_the_pixel_and_round_trips() {
    use herdr_client::protocol::PaneSurfaceScrollMetrics;
    let rect = SurfaceRect {
        x: 79,
        y: 0,
        width: 1,
        height: 24,
    };
    let pane = |offset, max| PaneSurfacePane {
        pane_id: "p".into(),
        content_revision: 1,
        rect: SurfaceRect {
            x: 0,
            y: 0,
            width: 80,
            height: 24,
        },
        inner_rect: SurfaceRect {
            x: 0,
            y: 0,
            width: 79,
            height: 24,
        },
        scrollbar_rect: Some(rect),
        scroll: Some(PaneSurfaceScrollMetrics {
            offset_from_bottom: offset,
            max_offset_from_bottom: max,
            viewport_rows: 24,
        }),
        focused: true,
        mouse_reporting: false,
        sgr_pixel_mouse: false,
        alternate_screen_active: false,
        pixel_width: 0,
        pixel_height: 0,
    };
    assert!(Scrollbar::new(&pane(0, 0), 8., 20.).is_none());
    let bottom = Scrollbar::new(&pane(0, 1978), 8., 20.).unwrap();
    let top = Scrollbar::new(&pane(1978, 1978), 8., 20.).unwrap();
    let one = Scrollbar::new(&pane(1, 1978), 8., 20.).unwrap();
    assert_eq!(
        bottom.track,
        Bounds::new(point(px(632.), px(0.)), size(px(8.), px(480.)))
    );
    assert_eq!(bottom.thumb.size.height, px(MIN_THUMB));
    assert_eq!(bottom.thumb.bottom(), bottom.track.bottom());
    assert_eq!(top.thumb.top(), top.track.top());
    // One line moves the thumb a fraction of a pixel, not a whole cell.
    let step = f32::from(bottom.thumb.top() - one.thumb.top());
    assert!(step > 0. && step < 1., "{step}");
    for offset in [0, 1, 500, 1977, 1978] {
        let bar = Scrollbar::new(&pane(offset, 1978), 8., 20.).unwrap();
        assert_eq!(bar.offset_at(f32::from(bar.thumb.top())), offset);
    }
    assert_eq!(bottom.offset_at(-100.), 1978);
    assert_eq!(bottom.offset_at(1000.), 0);
}
