use super::*;

const DIGEST: &str = "00000000000000ff00000000000000ff";

fn chunk(digest: &str, total: usize, offset: usize, data: &[u8]) -> Vec<u8> {
    let encoded = encode(data);
    format!(
        "{{\"kittyImageChunk\":{{\"digest\":\"{digest}\",\"format\":\"rgba\",\"width\":2,\
         \"height\":2,\"total\":{total},\"offset\":{offset},\"data\":\"{encoded}\"}}}}\n"
    )
    .into_bytes()
}

fn encode(data: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for group in data.chunks(3) {
        let n = group
            .iter()
            .enumerate()
            .fold(0u32, |acc, (i, b)| acc | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..4 {
            if i <= group.len() {
                out.push(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn placement(row: u16, source_row: u16) -> Placement {
    Placement {
        digest: DIGEST.into(),
        row,
        column: 3,
        rows: 1,
        columns: 4,
        source_row,
        source_column: 0,
        total_rows: 2,
        total_columns: 4,
    }
}

#[test]
fn assembles_chunks_and_maps_placements_onto_source_rectangles() -> anyhow::Result<()> {
    let store = Store::default();
    let pixels = [7u8; 16];
    store.accept_line(&chunk(DIGEST, 16, 0, &pixels[..9]))?;
    assert!(store.scene(&[placement(0, 1)]).is_empty());
    assert!(!store.take_changed());
    store.accept_line(&chunk(DIGEST, 16, 9, &pixels[9..]))?;
    assert!(store.take_changed());
    let scene = store.scene(&[placement(5, 1)]);
    let p = &scene[0];
    assert_eq!((p.x, p.y, p.cols, p.rows), (3, 5, 4, 1));
    assert_eq!((p.source_x, p.source_y), (0, 1));
    assert_eq!((p.source_width, p.source_height), (2, 1));
    assert!(store.with_images(|images| images.get(&p.asset).is_some()));
    Ok(())
}

#[test]
fn out_of_order_chunks_drop_the_partial_image() -> anyhow::Result<()> {
    let store = Store::default();
    let pixels = [1u8; 16];
    store.accept_line(&chunk(DIGEST, 16, 0, &pixels[..8]))?;
    store.accept_line(&chunk(DIGEST, 16, 12, &pixels[12..]))?;
    store.accept_line(&chunk(DIGEST, 16, 8, &pixels[8..12]))?;
    assert!(store.scene(&[placement(0, 0)]).is_empty());
    assert!(!store.take_changed());
    Ok(())
}

#[test]
fn rejects_malformed_chunks_and_placements() {
    let store = Store::default();
    assert!(store.accept_line(&chunk("XYZ", 16, 0, &[1, 2, 3])).is_err());
    assert!(validate(&[placement(0, 1)], 7, 1).is_ok());
    assert!(validate(&[placement(1, 1)], 7, 1).is_err());
    assert!(validate(&[placement(0, 2)], 7, 1).is_err());
    assert!(is_chunk_line(&chunk(DIGEST, 16, 0, &[1])));
    assert!(!is_chunk_line(b"{\"version\":1}"));
}

#[test]
fn reports_referenced_images_that_never_arrive_once() {
    let store = Store::default();
    store.scene(&[placement(0, 0)]);
    assert!(
        store.take_missing().is_empty(),
        "grace period for in-flight bytes"
    );
    {
        let mut inner = store.lock();
        for since in inner.referenced.values_mut() {
            *since -= UNSEEN;
        }
    }
    assert_eq!(store.take_missing(), [DIGEST.to_string()]);
    assert!(store.take_missing().is_empty(), "rate limited");
}

/// Replayed from a real tmux 3.7c control-mode transcript (see
/// `scripts/kitty-spike`): a cursor-anchored PNG after "A", a Unicode
/// placeholder image, and a DCS-passthrough-wrapped PNG.
const FIXTURE: &[u8] = include_bytes!("../../../../../fixtures/kitty-graphics-snapshot.json");

#[gpui::test]
fn paints_real_wire_kitty_images_at_their_cells(cx: &mut gpui::TestAppContext) {
    use crate::{
        config::Theme,
        terminal_painter::{ImageTarget, PlacedImages, TerminalPainter},
    };
    use gpui::{Bounds, Empty, Point, Styled, VisualTestContext, canvas, font, point, px, size};
    let frame =
        Arc::new(super::super::decode::frame(FIXTURE).unwrap_or_else(|error| panic!("{error}")));
    let store = Store::default();
    let placements = load_static(FIXTURE, frame.width, frame.height, &store)
        .unwrap_or_else(|error| panic!("{error}"));
    let scene = Arc::new(store.scene(&placements));
    assert_eq!(scene.len(), 3);
    let (_, cx) = cx.add_window_view(|_, _| Empty);
    let painter = std::rc::Rc::new(std::cell::RefCell::new(TerminalPainter::default()));
    painter
        .borrow_mut()
        .set_appearance(14., 20., Theme::default());
    let draw = |cx: &mut VisualTestContext| {
        let (painter, store, scene, frame) =
            (painter.clone(), store.clone(), scene.clone(), frame.clone());
        cx.draw(Point::default(), size(px(800.), px(600.)), |_, _| {
            canvas(
                |_, _, _| (),
                move |_, _, window, cx| {
                    store.with_images(|images| {
                        painter.borrow_mut().paint_frame(
                            &frame,
                            point(px(0.), px(0.)),
                            None,
                            10.,
                            &font("Menlo"),
                            &[],
                            &[],
                            None,
                            Some(PlacedImages {
                                placements: &scene,
                                images,
                                target: ImageTarget::Main,
                            }),
                            window,
                            cx,
                        )
                    });
                },
            )
            .size_full()
        });
    };
    draw(cx);
    cx.run_until_parked();
    draw(cx);
    let cells = |col: f32, row: f32, cols: f32, rows: f32| {
        Bounds::new(
            point(px(col * 10.), px(row * 20.)),
            size(px(cols * 10.), px(rows * 20.)),
        )
    };
    let mut painted: Vec<_> = painter
        .borrow()
        .painted_images()
        .iter()
        .map(|(_, bounds)| *bounds)
        .collect();
    painted.sort_by(|a, b| f32::from(a.origin.y).total_cmp(&f32::from(b.origin.y)));
    assert_eq!(
        painted,
        [
            cells(1., 2., 4., 2.),
            cells(0., 7., 3., 2.),
            cells(0., 13., 4., 2.)
        ]
    );
}
