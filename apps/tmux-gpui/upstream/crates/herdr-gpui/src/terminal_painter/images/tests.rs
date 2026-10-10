use super::*;
use herdr_client::protocol::SurfaceGraphicsTarget;

fn key(format: SurfaceGraphicsFormat, width: u32, height: u32) -> SurfaceGraphicsAssetKey {
    let channels = match format {
        SurfaceGraphicsFormat::Rgb => 3,
        _ => 4,
    };
    SurfaceGraphicsAssetKey {
        source: SurfaceGraphicsSource::Terminal {
            target: SurfaceGraphicsTarget::Pane {
                pane_id: "p1".into(),
            },
            image_id: 1,
        },
        image_width: width,
        image_height: height,
        format,
        data_len: u64::from(width * height * channels),
        data_fingerprint: 0,
    }
}

fn placement(key: SurfaceGraphicsAssetKey) -> SurfaceGraphicsPlacement {
    SurfaceGraphicsPlacement {
        asset: key,
        logical_placement_id: 1,
        x: 2,
        y: 1,
        cols: 4,
        rows: 2,
        source_x: 0,
        source_y: 0,
        source_width: 0,
        source_height: 0,
        x_offset: 0,
        y_offset: 0,
        z: 0,
        scrollback_offset: 0,
    }
}

fn grid(width: f32, height: f32) -> Bounds<Pixels> {
    Bounds::new(point(px(100.), px(50.)), size(px(width), px(height)))
}

#[test]
fn raw_pixels_become_bgra_with_opaque_rgb() {
    let rgb = decode(&key(SurfaceGraphicsFormat::Rgb, 1, 1), &[1, 2, 3]).unwrap();
    assert_eq!(rgb.as_raw(), &[3, 2, 1, 255]);
    let rgba = decode(&key(SurfaceGraphicsFormat::Rgba, 1, 1), &[1, 2, 3, 4]).unwrap();
    assert_eq!(rgba.as_raw(), &[3, 2, 1, 4]);
    // Bytes that disagree with their key are refused, never reinterpreted.
    assert!(matches!(
        decode(&key(SurfaceGraphicsFormat::Rgba, 1, 1), &[1, 2, 3]),
        Err(Error::PaneImageLimit)
    ));
}

#[test]
fn png_is_decoded_under_limits_and_garbage_is_an_error() {
    let mut png = Vec::new();
    RgbaImage::from_raw(2, 1, vec![10, 20, 30, 40, 50, 60, 70, 80])
        .unwrap()
        .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
        .unwrap();
    let mut asset = key(SurfaceGraphicsFormat::Png, 2, 1);
    asset.data_len = png.len() as u64;
    let decoded = decode(&asset, &png).unwrap();
    assert_eq!(decoded.as_raw(), &[30, 20, 10, 40, 70, 60, 50, 80]);
    asset.data_len = 4;
    assert!(matches!(
        decode(&asset, b"nope"),
        Err(Error::PaneImageDecode(_))
    ));
}

#[test]
fn oversized_images_are_scaled_to_the_texture_limit() {
    let (width, height) = (MAX_TEXTURE_SIDE * 2, 2);
    let asset = key(SurfaceGraphicsFormat::Rgba, width, height);
    let data = vec![255; asset.data_len as usize];
    let decoded = decode(&asset, &data).unwrap();
    assert_eq!(decoded.dimensions(), (MAX_TEXTURE_SIDE, 1));
}

#[test]
fn placements_cover_their_cells_on_the_text_grid() {
    let placed = placement(key(SurfaceGraphicsFormat::Rgba, 40, 20));
    let origin = point(px(100.), px(50.));
    let found = geometry(&placed, origin, (10., 20.), grid(1000., 1000.)).unwrap();
    let expected = Bounds::new(point(px(120.), px(70.)), size(px(40.), px(40.)));
    assert_eq!(found.visible, expected);
    assert_eq!(found.image, expected);
}

#[test]
fn source_rectangles_and_offsets_map_like_herdr() {
    let mut placed = placement(key(SurfaceGraphicsFormat::Rgba, 40, 20));
    // Bottom half of the image, shrunk by a 4px leading offset at a
    // fractional 7.5px cell the client reported as 8px.
    placed.source_y = 10;
    placed.source_height = 10;
    placed.x_offset = 4;
    let origin = point(px(100.), px(50.));
    let found = geometry(&placed, origin, (7.5, 20.), grid(1000., 1000.)).unwrap();
    let left = 100. + 2. * 7.5 + 4. * 7.5 / 8.;
    let width = 4. * 7.5 - 4. * 7.5 / 8.;
    assert_eq!(
        found.visible,
        Bounds::new(point(px(left), px(70.)), size(px(width), px(40.)))
    );
    // Ten source rows fill forty pixels, so the whole image is twice as
    // tall and starts forty pixels above.
    assert_eq!(
        found.image,
        Bounds::new(point(px(left), px(30.)), size(px(width), px(80.)))
    );
}

#[test]
fn placements_are_clipped_to_their_grid_and_bad_sources_skipped() {
    let mut placed = placement(key(SurfaceGraphicsFormat::Rgba, 40, 20));
    placed.cols = 1_000_000;
    let origin = point(px(100.), px(50.));
    let found = geometry(&placed, origin, (10., 20.), grid(100., 100.)).unwrap();
    assert_eq!(found.visible.right(), px(200.));
    placed.cols = 4;
    placed.x = 50;
    assert!(geometry(&placed, origin, (10., 20.), grid(100., 100.)).is_none());
    let mut outside = placement(key(SurfaceGraphicsFormat::Rgba, 40, 20));
    outside.source_x = 40;
    assert!(geometry(&outside, origin, (10., 20.), grid(1000., 1000.)).is_none());
    outside.source_x = 0;
    outside.rows = 0;
    assert!(geometry(&outside, origin, (10., 20.), grid(1000., 1000.)).is_none());
}

#[test]
fn targets_select_main_or_their_own_popup() {
    let pane = key(SurfaceGraphicsFormat::Rgba, 1, 1);
    let mut popup = pane.clone();
    popup.source = SurfaceGraphicsSource::Terminal {
        target: SurfaceGraphicsTarget::Popup {
            terminal_id: "t".into(),
        },
        image_id: 1,
    };
    assert!(ImageTarget::Main.places(&pane.source));
    assert!(!ImageTarget::Main.places(&popup.source));
    assert!(ImageTarget::Popup("t").places(&popup.source));
    assert!(!ImageTarget::Popup("other").places(&popup.source));
    assert!(!ImageTarget::Popup("t").places(&pane.source));
}

fn ready(cache: &mut ImageCache, serial: u64, side: u32, now: Instant) {
    assert!(matches!(cache.lookup(serial, now), Lookup::Decode));
    cache.finish(serial, Ok(Arc::new(texture(RgbaImage::new(side, side)))));
}

#[test]
fn decodes_are_bounded_and_failures_are_not_retried() {
    let mut cache = ImageCache::default();
    let now = Instant::now();
    cache.begin(now);
    for serial in 0..MAX_DECODES as u64 {
        assert!(matches!(cache.lookup(serial, now), Lookup::Decode));
    }
    assert!(matches!(cache.lookup(99, now), Lookup::Wait));
    assert!(matches!(cache.lookup(0, now), Lookup::Wait));
    cache.finish(0, Err(Error::PaneImageLimit));
    cache.finish(1, Ok(Arc::new(texture(RgbaImage::new(1, 1)))));
    assert!(matches!(cache.lookup(0, now), Lookup::Wait));
    assert!(matches!(cache.lookup(1, now), Lookup::Ready(_)));
    // A late result for an unknown serial is ignored.
    cache.finish(7, Ok(Arc::new(texture(RgbaImage::new(1, 1)))));
    assert!(matches!(cache.lookup(99, now), Lookup::Decode));
}

#[test]
fn finished_background_decodes_land_on_the_next_paint() {
    let mut cache = ImageCache::default();
    let now = Instant::now();
    assert!(matches!(cache.lookup(1, now), Lookup::Decode));
    cache
        .finished
        .lock()
        .unwrap()
        .push((1, Ok(RgbaImage::new(2, 2))));
    assert!(cache.begin(now).is_empty());
    assert!(matches!(cache.lookup(1, now), Lookup::Ready(_)));
    assert_eq!(cache.bytes, 16);
}

#[test]
fn textures_are_released_when_idle_or_over_budget() {
    let mut cache = ImageCache::default();
    let start = Instant::now();
    cache.begin(start);
    ready(&mut cache, 1, 1, start);
    ready(&mut cache, 2, 1, start);
    cache.begin(start + IDLE / 2);
    assert!(matches!(
        cache.lookup(2, start + IDLE / 2),
        Lookup::Ready(_)
    ));
    let released = cache.begin(start + IDLE);
    assert_eq!(released.len(), 1, "only the idle texture leaves");
    assert!(cache.entries.contains_key(&2) && !cache.entries.contains_key(&1));
    assert_eq!(cache.bytes, 4);

    // Over budget, the least recently used goes first; this paint's stay.
    // Each texture is charged a quarter of the budget without allocating it.
    let mut cache = ImageCache::default();
    let quarter = MAX_TEXTURE_BYTES / 4;
    for serial in 0..5 {
        cache.begin(start);
        ready(&mut cache, serial, 1, start);
        let entry = cache.entries.get_mut(&serial).unwrap();
        cache.bytes += quarter - entry.bytes;
        entry.bytes = quarter;
    }
    let released = cache.begin(start);
    assert_eq!(released.len(), 1);
    assert!(!cache.entries.contains_key(&0));
    assert!(cache.bytes <= MAX_TEXTURE_BYTES);
}
