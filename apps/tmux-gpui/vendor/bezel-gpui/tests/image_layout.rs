#![cfg(feature = "test-support")]

use gpui::{
    AvailableSpace, Img, IntoElement, Pixels, RenderImage, Size, Styled, TestAppContext, canvas,
    img, point, px, size,
};
use image::{Frame, RgbaImage};
use std::{cell::Cell, rc::Rc, sync::Arc};

fn image(width: u32, height: u32) -> Img {
    img(Arc::new(RenderImage::new([Frame::new(RgbaImage::new(
        width, height,
    ))])))
}

fn measure(cx: &mut TestAppContext, image: Img) -> Size<Pixels> {
    measure_with_frame(cx, image).0
}

fn measure_with_frame(cx: &mut TestAppContext, image: Img) -> (Size<Pixels>, Size<Pixels>) {
    let measured = Rc::new(Cell::new((Size::default(), Size::default())));
    cx.add_empty_window()
        .draw(point(px(0.), px(0.)), size(px(318.), px(200.)), |_, _| {
            canvas(
                {
                    let measured = measured.clone();
                    move |_, window, cx| {
                        let mut image = image.into_any_element();
                        let image_layout = image.request_layout(window, cx);
                        let mut parent = gpui::Style::default();
                        parent.display = gpui::Display::Flex;
                        parent.flex_direction = gpui::FlexDirection::Column;
                        parent.align_items = Some(gpui::AlignItems::FlexStart);
                        parent.size.width = px(318.).into();
                        let mut frame = gpui::Style::default();
                        frame.max_size.width = gpui::relative(1.).into();
                        frame.align_self = Some(gpui::AlignSelf::FlexStart);
                        let frame_layout = window.request_layout(frame, [image_layout], cx);
                        let parent_layout = window.request_layout(parent, [frame_layout], cx);
                        window.compute_layout(
                            parent_layout,
                            size(AvailableSpace::MaxContent, AvailableSpace::MaxContent),
                            cx,
                        );
                        measured.set((
                            window.layout_bounds(image_layout).size,
                            window.layout_bounds(frame_layout).size,
                        ));
                    }
                },
                |_, _, _, _| {},
            )
        });
    measured.get()
}

#[gpui::test]
fn image_max_width_preserves_intrinsic_proportions(cx: &mut TestAppContext) {
    let (image, measured) = measure_with_frame(cx, image(1000, 20).max_w_full());
    assert_eq!(image, measured);
    assert_eq!(measured.width, px(318.));
    assert!(
        (f32::from(measured.height) - 6.36).abs() <= 0.5,
        "{measured:?}"
    );
}

#[gpui::test]
fn image_sizing_preserves_explicit_dimensions(cx: &mut TestAppContext) {
    assert_eq!(measure(cx, image(1000, 20)), size(px(1000.), px(20.)));
    assert_eq!(measure(cx, image(100, 20)), size(px(100.), px(20.)));
    assert_eq!(
        measure(cx, image(100, 20).w(px(200.))),
        size(px(200.), px(40.))
    );
    assert_eq!(
        measure(cx, image(100, 20).h(px(40.))),
        size(px(200.), px(40.))
    );
    assert_eq!(
        measure(cx, image(100, 20).w(px(200.)).h(px(60.))),
        size(px(200.), px(60.)),
    );
}

#[gpui::test]
fn empty_image_has_zero_intrinsic_size(cx: &mut TestAppContext) {
    let empty = img(Arc::new(RenderImage::new(Vec::<Frame>::new())));
    assert_eq!(measure(cx, empty), size(px(0.), px(0.)));
}

#[gpui::test]
fn image_constraints_preserve_auto_dimensions(cx: &mut TestAppContext) {
    for image in [
        image(1000, 20).w(px(1000.)).max_w_full(),
        image(1000, 20).w_full(),
    ] {
        let measured = measure(cx, image);
        assert_eq!(measured.width, px(318.));
        assert!(
            (f32::from(measured.height) - 6.36).abs() <= 0.5,
            "{measured:?}"
        );
    }
    assert_eq!(
        measure(cx, image(100, 20).min_w(px(200.))),
        size(px(200.), px(40.))
    );
    assert_eq!(
        measure(cx, image(100, 20).aspect_ratio(2.)),
        size(px(100.), px(50.))
    );
}
