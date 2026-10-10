#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Optional surface encodings: Herdr encoder fixtures, malformed input,
//! bounds, and revision fencing. Every rejection must leave the frame intact.

use base64::{Engine as _, engine::general_purpose::STANDARD_NO_PAD};
use herdr_protocol::{
    surface_delta::{GridUpdate, SurfaceDelta},
    surface_reuse::SurfaceReuse,
    surface_scroll::{ScrollPatch, SurfaceScroll},
    *,
};

const WIDTH: u16 = 6;
const HEIGHT: u16 = 5;

fn cell(symbol: &str) -> CellData {
    CellData {
        symbol: symbol.into(),
        fg: 0,
        bg: 0,
        modifier: 0,
        skip: false,
        hyperlink: None,
    }
}

fn pane() -> PaneSurfacePane {
    let rect = SurfaceRect {
        x: 0,
        y: 0,
        width: WIDTH,
        height: HEIGHT,
    };
    PaneSurfacePane {
        pane_id: "w1:p1".into(),
        content_revision: 1,
        rect,
        inner_rect: rect,
        scrollbar_rect: None,
        scroll: None,
        focused: true,
        mouse_reporting: false,
        sgr_pixel_mouse: false,
        alternate_screen_active: false,
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// Row `y` is filled with the digit `y`, so moved rows are easy to read.
fn surface() -> PaneSurfaceFrame {
    let cells = (0..HEIGHT)
        .flat_map(|y| (0..WIDTH).map(move |_| cell(&y.to_string())))
        .collect();
    PaneSurfaceFrame {
        boot_id: "boot".into(),
        projection_revision: 3,
        surface_revision: 10,
        frame: FrameData {
            cells,
            width: WIDTH,
            height: HEIGHT,
            cursor: None,
            hyperlinks: vec!["https://herdr.dev".into()],
            graphics: vec![],
        },
        panes: vec![pane()],
        splits: vec![],
        popup: None,
        graphics: SurfaceGraphicsScene::default(),
    }
}

fn rows(frame: &PaneSurfaceFrame) -> Vec<String> {
    frame
        .frame
        .cells
        .chunks(usize::from(frame.frame.width))
        .map(|row| row.iter().map(|c| c.symbol.as_str()).collect())
        .collect()
}

fn patch(base: &PaneSurfaceFrame, rows: Vec<PaneSurfacePatchRow>) -> PaneSurfacePatch {
    PaneSurfacePatch {
        boot_id: base.boot_id.clone(),
        projection_revision: base.projection_revision,
        base_surface_revision: base.surface_revision,
        surface_revision: base.surface_revision + 1,
        rows,
        panes: vec![pane()],
        cursor: None,
    }
}

fn whole_pane(shift: i16) -> SurfaceScroll {
    SurfaceScroll {
        rect: pane().inner_rect,
        shift,
    }
}

fn line(y: u16, symbol: &str) -> PaneSurfacePatchRow {
    PaneSurfacePatchRow {
        x: 0,
        y,
        cells: vec![cell(symbol); usize::from(WIDTH)],
    }
}

fn scroll(base: &PaneSurfaceFrame, scrolls: Vec<SurfaceScroll>) -> ScrollPatch {
    ScrollPatch {
        scrolls,
        patch: patch(base, vec![line(HEIGHT - 1, "n")]),
    }
}

#[test]
fn scroll_shifts_rows_then_applies_the_residual_patch() {
    let mut up = surface();
    let encoded = scroll(&up, vec![whole_pane(1)]).encode().unwrap();
    up.apply_scroll_patch(surface_scroll::decode(&encoded).unwrap())
        .unwrap();
    assert_eq!(
        rows(&up),
        ["111111", "222222", "333333", "444444", "nnnnnn"]
    );
    assert_eq!(up.surface_revision, 11);

    let mut down = surface();
    let mut message = scroll(&down, vec![whole_pane(-2)]);
    message.patch.rows = vec![line(0, "a"), line(1, "b")];
    down.apply_scroll_patch(message).unwrap();
    assert_eq!(
        rows(&down),
        ["aaaaaa", "bbbbbb", "000000", "111111", "222222"]
    );
}

#[test]
fn scroll_regions_only_move_their_own_columns() {
    let mut frame = surface();
    let left = SurfaceScroll {
        rect: SurfaceRect {
            x: 0,
            y: 0,
            width: 2,
            height: HEIGHT,
        },
        shift: 1,
    };
    let right = SurfaceScroll {
        rect: SurfaceRect {
            x: 4,
            y: 1,
            width: 2,
            height: 3,
        },
        shift: -1,
    };
    let message = ScrollPatch {
        scrolls: vec![left, right],
        patch: patch(&frame, vec![]),
    };
    frame.apply_scroll_patch(message).unwrap();
    assert_eq!(
        rows(&frame),
        ["110000", "221133", "332211", "443322", "004444"]
    );
}

#[test]
fn scroll_rejects_malformed_payloads() {
    let base = surface();
    let valid = scroll(&base, vec![whole_pane(1)]).encode().unwrap();
    let bytes = STANDARD_NO_PAD.decode(&valid).unwrap();
    let encode = |bytes: &[u8]| STANDARD_NO_PAD.encode(bytes);

    assert!(matches!(
        surface_scroll::decode(""),
        Err(Error::ScrollTruncated)
    ));
    assert!(matches!(
        surface_scroll::decode("!!"),
        Err(Error::EncodingPayload(_))
    ));
    assert!(matches!(
        surface_scroll::decode(&encode(&[0])),
        Err(Error::ScrollCount)
    ));
    assert!(matches!(
        surface_scroll::decode(&encode(&[65])),
        Err(Error::ScrollCount)
    ));
    assert!(matches!(
        surface_scroll::decode(&encode(&[1, 0, 0])),
        Err(Error::ScrollTruncated)
    ));
    let mut trailing = bytes.clone();
    trailing.push(0);
    assert!(matches!(
        surface_scroll::decode(&encode(&trailing)),
        Err(Error::TrailingBytes)
    ));
    // The framed payload must be complete and must be a pane patch.
    assert!(surface_scroll::decode(&encode(&bytes[..bytes.len() - 1])).is_err());
    let mut wrong = bytes[..11].to_vec();
    write_message(
        &mut wrong,
        &ServerMessage::PaneSurface(base.clone()),
        MAX_FRAME_SIZE,
    )
    .unwrap();
    assert!(matches!(
        surface_scroll::decode(&encode(&wrong)),
        Err(Error::ScrollPayload)
    ));
    let oversized = "A".repeat(base64::encoded_len(MAX_FRAME_SIZE, false).unwrap() + 1);
    assert!(matches!(
        surface_scroll::decode(&oversized),
        Err(Error::EncodingLimit)
    ));
    let too_many = ScrollPatch {
        scrolls: vec![whole_pane(1); 256],
        patch: patch(&base, vec![]),
    };
    assert!(matches!(too_many.encode(), Err(Error::ScrollCount)));
}

#[test]
fn scroll_rejects_bad_geometry_without_touching_the_frame() {
    let rect = pane().inner_rect;
    let at = |x, y, width, height, shift| SurfaceScroll {
        rect: SurfaceRect {
            x,
            y,
            width,
            height,
        },
        shift,
    };
    let invalid = [
        vec![at(0, 0, WIDTH + 1, HEIGHT, 1)],
        vec![at(0, 1, WIDTH, HEIGHT, 1)],
        vec![at(0, 0, 0, HEIGHT, 1)],
        vec![at(0, 0, WIDTH, 1, 1)],
        vec![whole_pane(0)],
        vec![whole_pane(HEIGHT as i16)],
        vec![whole_pane(-(HEIGHT as i16))],
        vec![whole_pane(i16::MIN)],
        vec![at(u16::MAX, 0, 2, HEIGHT, 1)],
        vec![at(0, u16::MAX, WIDTH, 2, 1)],
        vec![whole_pane(1), at(rect.width - 1, 0, 1, 2, 1)],
    ];
    for scrolls in invalid {
        let mut frame = surface();
        let error = frame.apply_scroll_patch(scroll(&frame, scrolls.clone()));
        assert!(matches!(error, Err(Error::ScrollBounds)), "{scrolls:?}");
        assert_eq!(frame, surface(), "{scrolls:?}");
    }
}

#[test]
fn scroll_keeps_patch_bounds_and_revision_fencing() {
    let base = surface();
    type Expected = fn(&Error) -> bool;
    let mut cases: Vec<(ScrollPatch, Expected)> = Vec::new();
    let mut wrong_boot = scroll(&base, vec![whole_pane(1)]);
    wrong_boot.patch.boot_id = "other".into();
    cases.push((wrong_boot, |e| matches!(e, Error::PatchIdentity)));
    let mut wrong_projection = scroll(&base, vec![whole_pane(1)]);
    wrong_projection.patch.projection_revision += 1;
    cases.push((wrong_projection, |e| matches!(e, Error::PatchIdentity)));
    let mut stale_base = scroll(&base, vec![whole_pane(1)]);
    stale_base.patch.base_surface_revision -= 1;
    cases.push((stale_base, |e| matches!(e, Error::PatchIdentity)));
    let mut skipped = scroll(&base, vec![whole_pane(1)]);
    skipped.patch.surface_revision += 1;
    cases.push((skipped, |e| matches!(e, Error::PatchIdentity)));
    let mut wide_row = scroll(&base, vec![whole_pane(1)]);
    wide_row.patch.rows[0].x = 1;
    cases.push((wide_row, |e| matches!(e, Error::PatchRowBounds)));
    let mut link = scroll(&base, vec![whole_pane(1)]);
    link.patch.rows[0].cells[0].hyperlink = Some(1);
    cases.push((link, |e| matches!(e, Error::PatchRowBounds)));
    let mut moved = scroll(&base, vec![whole_pane(1)]);
    moved.patch.panes[0].inner_rect.height -= 1;
    cases.push((moved, |e| matches!(e, Error::PatchGeometry)));
    let mut cursor = scroll(&base, vec![whole_pane(1)]);
    cursor.patch.cursor = Some(CursorState {
        x: WIDTH,
        y: 0,
        visible: true,
        shape: 0,
    });
    cases.push((cursor, |e| matches!(e, Error::PatchCursorBounds)));
    for (message, expected) in cases {
        let mut frame = base.clone();
        let error = frame.apply_scroll_patch(message).unwrap_err();
        assert!(expected(&error), "{error:?}");
        assert_eq!(frame, base);
    }
    // Patches never apply under a popup, scrolled or not.
    let mut frame = base.clone();
    frame.popup = Some(Box::new(popup("popup", 2, 1)));
    let before = frame.clone();
    let message = scroll(&frame, vec![whole_pane(1)]);
    assert!(matches!(
        frame.apply_scroll_patch(message),
        Err(Error::PatchIdentity)
    ));
    assert_eq!(frame, before);
}

fn popup(terminal_id: &str, width: u16, height: u16) -> ClientShellPopupSurface {
    ClientShellPopupSurface {
        terminal_id: terminal_id.into(),
        title: "popup".into(),
        width: None,
        height: None,
        frame: FrameData {
            cells: vec![cell("p"); usize::from(width) * usize::from(height)],
            width,
            height,
            cursor: None,
            hyperlinks: vec![],
            graphics: vec![],
        },
        mouse_reporting: false,
        sgr_pixel_mouse: false,
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn metadata(base: &PaneSurfaceFrame) -> PaneSurfaceFrame {
    let mut next = base.clone();
    next.projection_revision += 1;
    next.surface_revision += 1;
    next.frame.cells.clear();
    if let Some(popup) = &mut next.popup {
        popup.frame.cells.clear();
    }
    next
}

fn delta(base: &PaneSurfaceFrame, rows: Vec<PaneSurfacePatchRow>) -> SurfaceDelta {
    SurfaceDelta {
        base_projection_revision: base.projection_revision,
        base_surface_revision: base.surface_revision,
        surface: metadata(base),
        rows,
        popup_cells: None,
    }
}

fn span(x: u16, y: u16, len: usize) -> PaneSurfacePatchRow {
    PaneSurfacePatchRow {
        x,
        y,
        cells: vec![cell("d"); len],
    }
}

fn decode_delta(delta: &SurfaceDelta) -> Result<SurfaceDelta> {
    surface_delta::decode(&delta.encode().unwrap())
}

#[test]
fn delta_rebuilds_cells_and_popups_from_the_baseline() {
    let base = surface();
    let message = delta(&base, vec![span(1, 0, 2), span(0, 4, 6)]);
    let next = decode_delta(&message).unwrap().reconstruct(&base).unwrap();
    assert_eq!(
        rows(&next),
        ["0dd000", "111111", "222222", "333333", "dddddd"]
    );
    assert_eq!(next.projection_revision, 4);
    assert_eq!(next.surface_revision, 11);

    let mut opened = next.clone();
    opened.popup = Some(Box::new(popup("popup", 3, 2)));
    let mut message = delta(&next, vec![]);
    message.surface.popup = metadata(&opened).popup;
    message.popup_cells = Some(GridUpdate::Replace(vec![cell("r"); 6]));
    let opened = decode_delta(&message).unwrap().reconstruct(&next).unwrap();
    let popup_cells = |frame: &PaneSurfaceFrame| -> String {
        let popup = frame.popup.as_ref().unwrap();
        popup
            .frame
            .cells
            .iter()
            .map(|c| c.symbol.as_str())
            .collect()
    };
    assert_eq!(popup_cells(&opened), "rrrrrr");

    let mut message = delta(&opened, vec![]);
    message.popup_cells = Some(GridUpdate::Patch(vec![span(2, 1, 1)]));
    let typed = decode_delta(&message)
        .unwrap()
        .reconstruct(&opened)
        .unwrap();
    assert_eq!(popup_cells(&typed), "rrrrrd");

    // A popup patch must target the same terminal and grid it replaces.
    let mut message = delta(&opened, vec![]);
    message.surface.popup.as_mut().unwrap().terminal_id = "other".into();
    message.popup_cells = Some(GridUpdate::Patch(vec![]));
    assert!(matches!(
        decode_delta(&message).unwrap().reconstruct(&opened),
        Err(Error::DeltaPopup)
    ));
}

#[test]
fn delta_rejects_malformed_spans_and_metadata() {
    let base = surface();
    let bad_rows = [
        vec![span(0, 0, 0)],
        vec![span(0, HEIGHT, 1)],
        vec![span(WIDTH, 0, 1)],
        vec![span(4, 0, 3)],
        vec![span(2, 1, 1), span(0, 1, 1)],
        vec![span(0, 1, 3), span(2, 1, 1)],
    ];
    for rows in bad_rows {
        assert!(
            matches!(
                decode_delta(&delta(&base, rows.clone())),
                Err(Error::DeltaSpan)
            ),
            "{rows:?}"
        );
    }
    // More spans than the grid has cells.
    let cells = usize::from(WIDTH) * usize::from(HEIGHT);
    let many = (0..=cells)
        .map(|i| span((i % 6) as u16, (i / 6) as u16, 1))
        .collect();
    assert!(matches!(
        decode_delta(&delta(&base, many)),
        Err(Error::DeltaSpan)
    ));

    let mut cells = delta(&base, vec![]);
    cells.surface.frame.cells.push(cell("x"));
    assert!(matches!(
        decode_delta(&cells),
        Err(Error::DeltaMetadataCells)
    ));
    let mut huge = delta(&base, vec![]);
    huge.surface.frame.width = 4097;
    assert!(matches!(decode_delta(&huge), Err(Error::DeltaGridLimit)));
    let mut huge = delta(&base, vec![]);
    (huge.surface.frame.width, huge.surface.frame.height) = (1001, 1000);
    assert!(matches!(decode_delta(&huge), Err(Error::DeltaGridLimit)));

    let mut orphan = delta(&base, vec![]);
    orphan.popup_cells = Some(GridUpdate::Replace(vec![]));
    assert!(matches!(decode_delta(&orphan), Err(Error::DeltaPopup)));
    let mut with_popup = base.clone();
    with_popup.popup = Some(Box::new(popup("popup", 2, 2)));
    let mut missing = delta(&with_popup, vec![]);
    assert!(matches!(decode_delta(&missing), Err(Error::DeltaPopup)));
    missing.popup_cells = Some(GridUpdate::Replace(vec![cell("r"); 3]));
    assert!(matches!(decode_delta(&missing), Err(Error::DeltaPopup)));
    missing.popup_cells = Some(GridUpdate::Patch(vec![span(2, 0, 1)]));
    assert!(matches!(decode_delta(&missing), Err(Error::DeltaSpan)));
    let mut popup_cells = delta(&with_popup, vec![]);
    popup_cells.surface.popup.as_mut().unwrap().frame.cells = vec![cell("x")];
    popup_cells.popup_cells = Some(GridUpdate::Patch(vec![]));
    assert!(matches!(
        decode_delta(&popup_cells),
        Err(Error::DeltaMetadataCells)
    ));

    let mut bytes = STANDARD_NO_PAD
        .decode(delta(&base, vec![]).encode().unwrap())
        .unwrap();
    bytes.push(0);
    assert!(matches!(
        surface_delta::decode(&STANDARD_NO_PAD.encode(&bytes)),
        Err(Error::TrailingBytes)
    ));
    assert!(matches!(surface_delta::decode(""), Err(Error::FrameLimit)));
    assert!(matches!(
        surface_delta::decode("@"),
        Err(Error::EncodingPayload(_))
    ));
    // Without graphics, a delta is held to the ordinary frame cap.
    let mut large = delta(&base, vec![]);
    large.surface.frame.hyperlinks = vec!["x".repeat(MAX_FRAME_SIZE)];
    assert!(matches!(decode_delta(&large), Err(Error::EncodingLimit)));
    assert!(matches!(
        surface_delta::decode(&"A".repeat(MAX_GRAPHICS_FRAME_SIZE + 1)),
        Err(Error::EncodingLimit)
    ));
}

#[test]
fn delta_and_reuse_are_fenced_on_their_baseline() {
    let base = surface();
    type Edit = fn(&mut SurfaceDelta);
    let edits: [Edit; 7] = [
        |d| d.surface.boot_id = "other".into(),
        |d| d.base_projection_revision += 1,
        |d| d.base_surface_revision -= 1,
        |d| d.surface.surface_revision += 1,
        |d| d.surface.projection_revision -= 2,
        |d| d.surface.frame.width -= 1,
        |d| d.surface.frame.height += 1,
    ];
    for edit in edits {
        let mut message = delta(&base, vec![]);
        edit(&mut message);
        assert!(matches!(
            message.reconstruct(&base),
            Err(Error::SurfaceBaseline)
        ));
    }

    let reuse = |base: &PaneSurfaceFrame| SurfaceReuse {
        base_surface_revision: base.surface_revision,
        surface: metadata(base),
    };
    let decode = |message: &SurfaceReuse| surface_reuse::decode(&message.encode().unwrap());
    let next = decode(&reuse(&base)).unwrap().reconstruct(&base).unwrap();
    assert_eq!(next.frame.cells, base.frame.cells);
    assert_eq!(next.surface_revision, base.surface_revision + 1);
    type ReuseEdit = fn(&mut SurfaceReuse);
    let edits: [ReuseEdit; 7] = [
        |r| r.surface.boot_id = "other".into(),
        |r| r.base_surface_revision -= 1,
        |r| r.surface.surface_revision += 1,
        |r| r.surface.projection_revision -= 2,
        |r| r.surface.frame.width -= 1,
        |r| r.surface.frame.height -= 1,
        |r| r.surface.frame.cells.push(cell("x")),
    ];
    for edit in edits {
        let mut message = reuse(&base);
        edit(&mut message);
        assert!(matches!(
            decode(&message).unwrap().reconstruct(&base),
            Err(Error::SurfaceBaseline)
        ));
    }
    assert!(matches!(
        surface_reuse::decode("{"),
        Err(Error::EncodingJson(_))
    ));
    assert!(matches!(
        surface_reuse::decode(&" ".repeat(MAX_FRAME_SIZE + 1)),
        Err(Error::EncodingLimit)
    ));
}

/// Frames from Herdr's own encoder (see NOTICE.md): a full baseline surface,
/// then pairs of an encoded control and the full surface it must reproduce.
fn fixture(bytes: &[u8]) -> (PaneSurfaceFrame, Vec<(String, String, PaneSurfaceFrame)>) {
    let mut reader = bytes;
    let mut next = || -> Option<ServerMessage> {
        (!reader.is_empty()).then(|| read_message(&mut reader, MAX_GRAPHICS_FRAME_SIZE).unwrap())
    };
    let Some(ServerMessage::PaneSurface(base)) = next() else {
        panic!("fixture starts with a full surface");
    };
    let mut steps = Vec::new();
    while let Some(message) = next() {
        let ServerMessage::EndpointControl { kind, data } = message else {
            panic!("fixture step is an encoded control");
        };
        let Some(ServerMessage::PaneSurface(expected)) = next() else {
            panic!("fixture step ends with the expected surface");
        };
        steps.push((kind, data, expected));
    }
    (base, steps)
}

fn replay(bytes: &[u8]) -> usize {
    let (mut current, steps) = fixture(bytes);
    let count = steps.len();
    for (kind, data, expected) in steps {
        current = match kind.as_str() {
            surface_scroll::MESSAGE_KIND => {
                let mut next = current.clone();
                next.apply_scroll_patch(surface_scroll::decode(&data).unwrap())
                    .unwrap();
                next
            }
            surface_delta::MESSAGE_KIND => surface_delta::decode(&data)
                .unwrap()
                .reconstruct(&current)
                .unwrap(),
            surface_reuse::MESSAGE_KIND => surface_reuse::decode(&data)
                .unwrap()
                .reconstruct(&current)
                .unwrap(),
            other => panic!("unexpected fixture kind {other}"),
        };
        current.frame.validate().unwrap();
        assert_eq!(current, expected, "{kind}");
    }
    count
}

#[test]
fn herdr_encoder_fixtures_reproduce_the_daemon_surface() {
    assert_eq!(
        replay(include_bytes!("fixtures/surface-scroll-up-v1.bin")),
        1
    );
    assert_eq!(
        replay(include_bytes!("fixtures/surface-scroll-down-v1.bin")),
        1
    );
    assert_eq!(replay(include_bytes!("fixtures/surface-delta-v1.bin")), 4);
    assert_eq!(replay(include_bytes!("fixtures/surface-reuse-v1.bin")), 1);
}

#[test]
fn herdr_scroll_fixture_carries_only_the_shift_and_new_rows() {
    let (_, steps) = fixture(include_bytes!("fixtures/surface-scroll-up-v1.bin"));
    let (_, data, _) = &steps[0];
    let scroll = surface_scroll::decode(data).unwrap();
    assert_eq!(scroll.scrolls.len(), 1);
    assert_eq!(scroll.scrolls[0].shift, 1);
    let cells: usize = scroll.patch.rows.iter().map(|row| row.cells.len()).sum();
    let pane = scroll.scrolls[0].rect;
    assert!(
        cells < usize::from(pane.width) * usize::from(pane.height) / 2,
        "{cells} residual cells"
    );
}
