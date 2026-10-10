use super::*;

#[gpui::test]
fn separator_paths_share_absolute_grid_edges_at_rounding_ties(cx: &mut TestAppContext) {
    let (_, cx) = cx.add_window_view(|_, _| Empty);
    cx.update(|window, _| {
        // At 2x the old origin + offset + width reaches 2439 instead of 2438.
        for (origin, column, row, width, height) in [
            (point(px(17.), px(23.)), 149, 0, 8.015, 40.),
            (point(px(23.), px(17.)), 0, 149, 40., 8.015),
            (point(px(3.25), px(7.13)), 50, 4, 23.750_002, 51.2),
        ] {
            let near = point(px(column as f32 * width), px(row as f32 * height));
            let far = point(
                px((column + 1) as f32 * width),
                px((row + 1) as f32 * height),
            );
            let (top_left, bottom_right) = grid_corners(window, origin, near, far);
            // The next cell's near edge, computed independently, is this one's far edge.
            assert_eq!(bottom_right, window.pixel_snap_point(origin + far));
            for separator in [
                CellSeparator::RightTriangle,
                CellSeparator::LeftTriangle,
                CellSeparator::RightRound,
                CellSeparator::LeftRound,
            ] {
                let Ok(path) = separator.path(top_left, bottom_right) else {
                    panic!("simple separator path must tessellate");
                };
                assert_eq!(path.bounds.origin, top_left);
                assert_eq!(path.bounds.right(), bottom_right.x);
                assert_eq!(path.bounds.bottom(), bottom_right.y);
            }
        }
    });
}

#[gpui::test]
fn adjacent_background_spans_share_snapped_edges(cx: &mut TestAppContext) {
    let (_, cx) = cx.add_window_view(|_, _| Empty);
    for (cell_width, start, end) in [
        (8., 12, 50),
        // At 2x, reconstituting this span's right edge loses one pixel.
        (8.015, 12, 50),
        (23.750_002, 19, 23),
    ] {
        for x in [0., 3., 3.25, 17.] {
            for height in [40., 51.2] {
                for uncached in [false, true] {
                    #[cfg(not(feature = "integration-test"))]
                    if uncached {
                        continue;
                    }
                    let origin = point(px(x), px(8.));
                    cx.draw(Point::default(), size(px(640.), px(200.)), |_, _| {
                        canvas(
                            |_, _, _| (),
                            move |_, _, window, cx| {
                                let frame = FrameData {
                                    width: (end + 1) as u16,
                                    height: 1,
                                    cells: (0..=end)
                                        .map(|index| CellData {
                                            fg: 0x02d2a241,
                                            bg: 0x02000000
                                                | if index < start {
                                                    0x57858b
                                                } else if index < end {
                                                    0xd2a241
                                                } else {
                                                    0x729b66
                                                },
                                            ..cell(if index == end { "\u{e0b0}" } else { " " })
                                        })
                                        .collect(),
                                    cursor: None,
                                    hyperlinks: vec![],
                                    graphics: vec![],
                                };
                                let mut painter = TerminalPainter::default();
                                painter.set_appearance(14., height, Theme::default());
                                #[cfg(feature = "integration-test")]
                                {
                                    painter.uncached = uncached;
                                }
                                painter.paint_frame(
                                    &frame,
                                    origin,
                                    None,
                                    cell_width,
                                    &font("Menlo"),
                                    &[],
                                    &[],
                                    None,
                                    None,
                                    window,
                                    cx,
                                );
                            },
                        )
                        .size_full()
                    });
                    cx.update(|window, _| {
                        let mut quads = window.painted_quads();
                        quads.sort_by_key(|quad| quad.bounds.left());
                        assert_eq!(quads.len(), if uncached { end + 1 } else { 3 });
                        for pair in quads.windows(2) {
                            assert_eq!(
                                pair[0].bounds.right(),
                                pair[1].bounds.left(),
                                "width={cell_width} origin={x} height={height} uncached={uncached}"
                            );
                        }
                    });
                }
            }
        }
    }
}

#[gpui::test]
fn separator_caps_use_cell_geometry_without_shaping(cx: &mut TestAppContext) {
    use herdr_client::{
        SurfaceImages,
        protocol::{
            SurfaceGraphicsAsset, SurfaceGraphicsAssetKey, SurfaceGraphicsFormat,
            SurfaceGraphicsPlacement, SurfaceGraphicsSource, SurfaceGraphicsTarget,
        },
    };
    let (_, cx) = cx.add_window_view(|_, _| Empty);
    let key = SurfaceGraphicsAssetKey {
        source: SurfaceGraphicsSource::Terminal {
            target: SurfaceGraphicsTarget::Pane {
                pane_id: "p1".into(),
            },
            image_id: 1,
        },
        image_width: 1,
        image_height: 1,
        format: SurfaceGraphicsFormat::Rgba,
        data_len: 4,
        data_fingerprint: 1,
    };
    let images: Arc<SurfaceImages> = Arc::new(
        [SurfaceGraphicsAsset {
            key: key.clone(),
            data: vec![1, 2, 3, 255],
        }]
        .into_iter()
        .collect(),
    );
    let placements: Arc<[SurfaceGraphicsPlacement]> = Arc::from([SurfaceGraphicsPlacement {
        asset: key,
        logical_placement_id: 1,
        x: 0,
        y: 0,
        cols: 1,
        rows: 1,
        source_x: 0,
        source_y: 0,
        source_width: 0,
        source_height: 0,
        x_offset: 0,
        y_offset: 0,
        z: -1,
        scrollback_offset: 0,
    }]);
    for with_image in [false, true] {
        let painter = std::rc::Rc::new(std::cell::RefCell::new(TerminalPainter::default()));
        painter
            .borrow_mut()
            .set_appearance(33., 51.2, Theme::default());
        let draw = |cx: &mut VisualTestContext| {
            let (painter, images, placements) =
                (painter.clone(), images.clone(), placements.clone());
            cx.draw(Point::default(), size(px(500.), px(150.)), |_, _| {
                canvas(
                    |_, _, _| (),
                    move |_, _, window, cx| {
                        let frame = FrameData {
                            width: 5,
                            height: 1,
                            cells: ["\u{e0b6}", "\u{e0b0}", "\u{e0b4}", "\u{e0b2}", "\u{e0b0}"]
                                .into_iter()
                                .enumerate()
                                .map(|(index, symbol)| CellData {
                                    fg: 0x02d79921,
                                    bg: 0x02689d6a,
                                    modifier: UNDERLINE | [0, REVERSED, DIM, HIDDEN, 0][index],
                                    skip: index == 4,
                                    ..cell(symbol)
                                })
                                .collect(),
                            cursor: None,
                            hyperlinks: vec![],
                            graphics: vec![],
                        };
                        #[cfg(feature = "integration-test")]
                        let before = *cx.default_global::<crate::performance::Counts>();
                        let mut painter = painter.borrow_mut();
                        painter.painted_separators.clear();
                        painter.paint_frame(
                            &frame,
                            point(px(17.), px(23.)),
                            None,
                            22.75,
                            &font("Menlo"),
                            &[],
                            &[],
                            None,
                            with_image.then_some(PlacedImages {
                                placements: &placements,
                                images: &images,
                                target: ImageTarget::Main,
                            }),
                            window,
                            cx,
                        );
                        assert_eq!(painter.glyphs.len(), 0);
                        let paths = &painter.painted_separators;
                        assert_eq!(paths.len(), 4);
                        for (index, (bounds, color)) in paths.iter().enumerate() {
                            // The last separator is wide: its skip cell belongs to it.
                            let end = if index == 3 { 5 } else { index + 1 };
                            let expected = Bounds::from_corners(
                                window.pixel_snap_point(point(
                                    px(17. + index as f32 * 22.75),
                                    px(23.),
                                )),
                                window.pixel_snap_point(point(
                                    px(17. + end as f32 * 22.75),
                                    px(23. + 51.2),
                                )),
                            );
                            assert_eq!(*bounds, expected);
                            assert_eq!(
                                *color,
                                rgb([0xd79921, 0x689d6a, 0x9f9a45, 0x689d6a][index])
                            );
                        }
                        #[cfg(feature = "integration-test")]
                        {
                            let after = cx.default_global::<crate::performance::Counts>();
                            assert_eq!(after.shapes, before.shapes);
                            assert_eq!(after.glyphs, before.glyphs);
                            assert_eq!(after.paint_errors, before.paint_errors);
                            assert_eq!(after.decorations - before.decorations, 5);
                            assert_eq!(after.paths - before.paths, 4);
                        }
                    },
                )
                .size_full()
            });
        };
        draw(cx);
        assert!(painter.borrow().painted_images.is_empty());
        cx.run_until_parked();
        draw(cx);
        let painted_images = &painter.borrow().painted_images;
        if with_image {
            // A decoded below-text image selects the separate text layer.
            assert_eq!(painted_images.len(), 1);
            let (z, bounds) = painted_images[0];
            assert_eq!(z, -1);
            assert_eq!(bounds.origin, point(px(17.), px(23.)));
            assert_eq!(bounds.size.width, px(22.75));
            assert!((f32::from(bounds.size.height) - 51.2).abs() < 0.0001);
        } else {
            assert!(painted_images.is_empty());
        }
    }
}

#[cfg(feature = "integration-test")]
#[gpui::test]
fn separator_region_paints_only_requested_layer_and_cells(cx: &mut TestAppContext) {
    let (_, cx) = cx.add_window_view(|_, _| Empty);
    for layer in Layer::ALL {
        cx.draw(Point::default(), size(px(200.), px(100.)), |_, _| {
            canvas(
                |_, _, _| (),
                move |_, _, window, cx| {
                    let frame = FrameData {
                        width: 5,
                        height: 1,
                        cells: ["x", "\u{e0b0}", "\u{e0b6}", "x", "x"]
                            .into_iter()
                            .enumerate()
                            .map(|(index, symbol)| CellData {
                                bg: 0x02000000 | (0x123450 + index as u32),
                                modifier: UNDERLINE,
                                ..cell(symbol)
                            })
                            .collect(),
                        cursor: None,
                        hyperlinks: vec![],
                        graphics: vec![],
                    };
                    let area = [Span {
                        row: 0,
                        columns: 1..3,
                    }];
                    // A whole-row selection must be clipped to this region too.
                    let highlights = [Highlight {
                        row: 0,
                        columns: 0..5,
                        tint: Tint::Selection,
                    }];
                    let mut painter = TerminalPainter::default();
                    painter.set_appearance(14., 40., Theme::default());
                    let before = *cx.default_global::<crate::performance::Counts>();
                    painter.paint_frame(
                        &frame,
                        point(px(17.), px(23.)),
                        Some(size(px(42.), px(47.))),
                        8.015,
                        &font("Menlo"),
                        &highlights,
                        &[],
                        Some(Part { area: &area, layer }),
                        None,
                        window,
                        cx,
                    );
                    let after = cx.default_global::<crate::performance::Counts>();
                    assert_eq!(after.shapes, before.shapes);
                    assert_eq!(after.glyphs, before.glyphs);
                    assert_eq!(after.paint_errors, before.paint_errors);
                    assert_eq!(painter.glyphs.len(), 0);
                    assert_eq!(
                        painter.painted_separators.len(),
                        if layer == Layer::Text { 2 } else { 0 }
                    );
                    for (index, (bounds, color)) in painter.painted_separators.iter().enumerate() {
                        assert_eq!(*color, rgb(painter.theme.foreground));
                        let expected = Bounds::from_corners(
                            window.pixel_snap_point(point(
                                px(17. + (index + 1) as f32 * 8.015),
                                px(23.),
                            )),
                            window.pixel_snap_point(point(
                                px(17. + (index + 2) as f32 * 8.015),
                                px(63.),
                            )),
                        );
                        assert_eq!(*bounds, expected);
                    }
                    assert_eq!(
                        after.quads - before.quads,
                        if layer == Layer::Backgrounds { 3 } else { 0 }
                    );
                    assert_eq!(
                        after.decorations - before.decorations,
                        if layer == Layer::Decorations { 2 } else { 0 }
                    );
                },
            )
            .size_full()
        });
        cx.update(|window, _| {
            let quads = window.painted_quads();
            assert_eq!(
                quads.len(),
                match layer {
                    Layer::Backgrounds => 3,
                    Layer::Text => 0,
                    Layer::Decorations => 2,
                }
            );
            let region = Bounds::from_corners(
                window.pixel_snap_point(point(px(17. + 8.015), px(23.))),
                window.pixel_snap_point(point(px(17. + 3. * 8.015), px(63.))),
            )
            .scale(window.scale_factor());
            for quad in quads {
                assert!(quad.bounds.left() >= region.left());
                assert!(quad.bounds.right() <= region.right());
            }
        });
    }
}
