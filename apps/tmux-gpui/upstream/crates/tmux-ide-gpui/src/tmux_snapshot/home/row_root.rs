//! A Home session row laid out on its own (perf plan, finding 2, step 1b).
//!
//! Taffy's flexbox allocates its working lists on every call, and the page
//! measures its column several times a frame. Each measure used to walk into
//! every row's star, name, agents and columns. A row is a fixed height and
//! the column's full width, so the page doesn't need to look inside it: to
//! the page, a [`RowRoot`] is one box with no children. Its row is laid out
//! once, as a root of its own, when the box's place is known (as gpui's
//! `uniform_list` lays out its items).
use gpui::*;

/// `row` in a box `height` tall and as wide as its parent. `row` should be
/// `w_full` and `height` tall itself: it is laid out to exactly that box.
pub(in crate::tmux_snapshot) fn row_root(height: Pixels, row: AnyElement) -> RowRoot {
    RowRoot {
        height,
        row: Some(row),
    }
}

pub(in crate::tmux_snapshot) struct RowRoot {
    height: Pixels,
    row: Option<AnyElement>,
}

impl IntoElement for RowRoot {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}

impl Element for RowRoot {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        style.size.height = self.height.into();
        style.flex_shrink = 0.;
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        if let Some(row) = self.row.as_mut() {
            row.layout_as_root(
                size(
                    AvailableSpace::Definite(bounds.size.width),
                    AvailableSpace::Definite(bounds.size.height),
                ),
                window,
                cx,
            );
            row.prepaint_at(bounds.origin, window, cx);
        }
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        if let Some(row) = self.row.as_mut() {
            row.paint(window, cx);
        }
    }
}
