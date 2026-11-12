//! The vendored GPUI's opt-in `cached_isolated` (vendor/bezel-gpui): what
//! reuses an isolated cached view and what renders it again, beside a plain
//! cached view whose behaviour must not change.
#![allow(clippy::unwrap_used)]
use core::prelude::v1::test;
use gpui::*;
use std::{cell::Cell, rc::Rc};

/// A leaf that counts its renders.
struct Leaf(Rc<Cell<usize>>);
impl Render for Leaf {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        self.0.set(self.0.get() + 1);
        div().size_full()
    }
}

/// A cached parent that holds the leaf, plainly cached or isolated.
struct Parent {
    leaf: Entity<Leaf>,
    isolated: bool,
    width: Pixels,
}
impl Render for Parent {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let style = StyleRefinement::default().size_full();
        let leaf = if self.isolated {
            self.leaf.clone().cached_isolated(style).into_any_element()
        } else {
            self.leaf.clone().cached(style).into_any_element()
        };
        div().size_full().child(div().w(self.width).h(px(40.)).child(leaf))
    }
}

/// The window root caches the parent, as `Root` caches `SnapshotView`.
struct Top(Entity<Parent>);
impl Render for Top {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .child(self.0.clone().cached(StyleRefinement::default().size_full()))
    }
}

fn open(
    cx: &mut TestAppContext,
    isolated: bool,
) -> (Entity<Parent>, Entity<Leaf>, Rc<Cell<usize>>, &mut VisualTestContext) {
    let renders = Rc::new(Cell::new(0));
    let count = renders.clone();
    let (top, cx) = cx.add_window_view(move |_, cx| {
        let leaf = cx.new(|_| Leaf(count));
        Top(cx.new(|_| Parent {
            leaf,
            isolated,
            width: px(100.),
        }))
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let parent = top.read_with(cx, |top, _| top.0.clone());
    let leaf = parent.read_with(cx, |parent, _| parent.leaf.clone());
    (parent, leaf, renders, cx)
}

/// Renders the leaf over one frame in which `change` happened.
fn renders_after(
    renders: &Rc<Cell<usize>>,
    cx: &mut VisualTestContext,
    change: impl FnOnce(&mut Window, &mut App),
) -> usize {
    let before = renders.get();
    cx.update(|window, cx| {
        change(window, cx);
        window.draw(cx).clear(cx);
    });
    renders.get() - before
}

#[gpui::test]
fn a_plain_cached_view_still_renders_with_its_parent(cx: &mut TestAppContext) {
    let (parent, _, renders, cx) = open(cx, false);
    let n = renders_after(&renders, cx, |_, cx| parent.update(cx, |_, cx| cx.notify()));
    assert_eq!(n, 1, "plain .cached() changed behaviour");
}

#[gpui::test]
fn an_isolated_view_is_reused_while_its_parent_renders(cx: &mut TestAppContext) {
    let (parent, _, renders, cx) = open(cx, true);
    let n = renders_after(&renders, cx, |_, cx| parent.update(cx, |_, cx| cx.notify()));
    assert_eq!(n, 0);
}

#[gpui::test]
fn an_isolated_view_renders_when_notified(cx: &mut TestAppContext) {
    let (_, leaf, renders, cx) = open(cx, true);
    let n = renders_after(&renders, cx, |_, cx| leaf.update(cx, |_, cx| cx.notify()));
    assert_eq!(n, 1);
}

/// `Window::refresh` reaches it: appearance, scale factor and focus changes
/// refresh the window in GPUI, and so does a theme change through `refresh`.
#[gpui::test]
fn an_isolated_view_renders_on_window_refresh(cx: &mut TestAppContext) {
    let (_, _, renders, cx) = open(cx, true);
    let n = renders_after(&renders, cx, |window, _| window.refresh());
    assert_eq!(n, 1);
}

/// New bounds invalidate it, as for a plain cached view.
#[gpui::test]
fn an_isolated_view_renders_when_its_bounds_change(cx: &mut TestAppContext) {
    let (parent, _, renders, cx) = open(cx, true);
    let n = renders_after(&renders, cx, |_, cx| {
        parent.update(cx, |parent, cx| {
            parent.width = px(120.);
            cx.notify();
        })
    });
    assert_eq!(n, 1);
}
