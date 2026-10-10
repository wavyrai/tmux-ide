#![allow(clippy::unwrap_used)]
// Named imports, not `super::*`: the parent glob-imports gpui, whose `test`
// attribute would then shadow the built-in one that `#[gpui::test]` expands to.
use super::{Buttons, framed, render_controls, selector};
use gpui::{
    Bounds, Context, Decorations, InteractiveElement, IntoElement, Modifiers, ParentElement,
    Pixels, Render, ResizeEdge, Styled, TestAppContext, Tiling, VisualTestContext, Window, div,
    point, px, size,
};
use std::{cell::Cell, rc::Rc};

const EDGES: [ResizeEdge; 8] = [
    ResizeEdge::Top,
    ResizeEdge::Bottom,
    ResizeEdge::Left,
    ResizeEdge::Right,
    ResizeEdge::TopLeft,
    ResizeEdge::TopRight,
    ResizeEdge::BottomLeft,
    ResizeEdge::BottomRight,
];

const ALL: Buttons = Buttons {
    minimize: true,
    maximize: true,
    maximized: false,
};

const FLOATING: Decorations = Decorations::Client {
    tiling: Tiling {
        top: false,
        left: false,
        right: false,
        bottom: false,
    },
};

struct Fixture {
    decorations: Decorations,
    buttons: Buttons,
    closed: Rc<Cell<usize>>,
}

impl Render for Fixture {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let closed = self.closed.clone();
        let theme = crate::config::Theme::default();
        framed(
            self.decorations,
            theme.active,
            div()
                .debug_selector(|| "fixture-body".into())
                .size_full()
                .flex()
                .child(div().flex_1())
                .child(render_controls(self.buttons, &theme, move |_, _| {
                    closed.set(closed.get() + 1);
                })),
        )
    }
}

fn open(
    cx: &mut TestAppContext,
    decorations: Decorations,
    buttons: Buttons,
) -> (Rc<Cell<usize>>, &mut VisualTestContext) {
    let closed = Rc::new(Cell::new(0));
    let shared = closed.clone();
    let (_, cx) = cx.add_window_view(move |_, _| Fixture {
        decorations,
        buttons,
        closed: shared,
    });
    cx.simulate_resize(size(px(400.), px(300.)));
    cx.update(|window, cx| {
        window.refresh();
        let _ = window.draw(cx);
    });
    (closed, cx)
}

fn full() -> Bounds<Pixels> {
    Bounds::new(point(px(0.), px(0.)), size(px(400.), px(300.)))
}

#[gpui::test]
fn server_decorations_add_no_frame(cx: &mut TestAppContext) {
    let (_, cx) = open(cx, Decorations::Server, ALL);
    assert!(cx.debug_bounds("window-frame").is_none());
    for edge in EDGES {
        assert!(cx.debug_bounds(selector(edge)).is_none(), "{edge:?}");
    }
    assert_eq!(cx.debug_bounds("fixture-body").unwrap(), full());
}

#[gpui::test]
fn floating_window_insets_content_and_keeps_handles_in_the_band(cx: &mut TestAppContext) {
    let (_, cx) = open(cx, FLOATING, ALL);
    let body = cx.debug_bounds("fixture-body").unwrap();
    // The inset, then the 1px border.
    assert_eq!(
        body,
        Bounds::new(point(px(11.), px(11.)), size(px(378.), px(278.)))
    );
    for edge in EDGES {
        let handle = cx.debug_bounds(selector(edge)).unwrap();
        assert!(!handle.intersects(&body), "{edge:?} covers content");
        assert!(full().contains(&handle.origin), "{edge:?}");
        assert!(handle.size.width > px(0.) && handle.size.height > px(0.));
    }
    assert_eq!(
        cx.debug_bounds(selector(ResizeEdge::TopRight)).unwrap(),
        Bounds::new(point(px(390.), px(0.)), size(px(10.), px(10.)))
    );
    assert_eq!(
        cx.debug_bounds(selector(ResizeEdge::Bottom)).unwrap(),
        Bounds::new(point(px(10.), px(290.)), size(px(380.), px(10.)))
    );
}

#[gpui::test]
fn tiled_edges_lose_their_inset_and_handles(cx: &mut TestAppContext) {
    let decorations = Decorations::Client {
        tiling: Tiling {
            top: true,
            left: true,
            right: false,
            bottom: false,
        },
    };
    let (_, cx) = open(cx, decorations, ALL);
    assert_eq!(
        cx.debug_bounds("fixture-body").unwrap(),
        Bounds::new(point(px(0.), px(0.)), size(px(389.), px(289.)))
    );
    for edge in EDGES {
        let kept = matches!(
            edge,
            ResizeEdge::Bottom | ResizeEdge::Right | ResizeEdge::BottomRight
        );
        assert_eq!(cx.debug_bounds(selector(edge)).is_some(), kept, "{edge:?}");
    }
}

#[gpui::test]
fn maximized_window_fills_the_surface(cx: &mut TestAppContext) {
    let maximized = Decorations::Client {
        tiling: Tiling::tiled(),
    };
    let (_, cx) = open(cx, maximized, ALL);
    assert_eq!(cx.debug_bounds("fixture-body").unwrap(), full());
    for edge in EDGES {
        assert!(cx.debug_bounds(selector(edge)).is_none(), "{edge:?}");
    }
}

#[gpui::test]
fn close_runs_the_windows_own_close_path(cx: &mut TestAppContext) {
    let (closed, cx) = open(cx, FLOATING, ALL);
    let minimize = cx.debug_bounds("window-minimize").unwrap();
    let maximize = cx.debug_bounds("window-maximize").unwrap();
    let close = cx.debug_bounds("window-close").unwrap();
    assert!(minimize.right() <= maximize.left());
    assert!(maximize.right() <= close.left());
    assert!(close.right() <= cx.debug_bounds("fixture-body").unwrap().right());
    assert_eq!(close.size, size(px(28.), px(28.)));

    cx.simulate_click(close.center(), Modifiers::default());
    assert_eq!(closed.get(), 1);
}

#[gpui::test]
fn unsupported_controls_are_not_offered(cx: &mut TestAppContext) {
    let close_only = Buttons {
        minimize: false,
        maximize: false,
        maximized: false,
    };
    let (_, cx) = open(cx, FLOATING, close_only);
    assert!(cx.debug_bounds("window-minimize").is_none());
    assert!(cx.debug_bounds("window-maximize").is_none());
    assert!(cx.debug_bounds("window-close").is_some());
}
