//! The sidebar builds only the rows near its visible part. A full refresh
//! of Home at 100 sessions spent about three quarters of its frame on
//! sidebar rows, most of them off screen, and so did every frame on which
//! an agent's state changed the sidebar.
//!
//! A row more than a quarter of the list's height above or below what shows
//! is drawn as an empty box of the size it had when it was last laid out.
//! So the list keeps its length, and every row keeps its child index:
//! keyboard reveal reads rows by index (`scroll_to_item`, `bounds_for_item`),
//! and a placeholder's bounds are its row's.
//!
//! Sizes are remembered per row shape: a digest of everything the row draws.
//! A row whose content changes (a summary added, a new kind, a new label)
//! has a new shape, so it is built and measured again. A row never measured
//! is built, and so is every row after it on that frame, since where they
//! sit is not known. Every size is forgotten when the text or the list's
//! width can have changed.
//!
//! The selected row and the keyboard's row stay built wherever they are.
//! While assistive technology reads the window every row is built: VoiceOver
//! must reach every row, and a placeholder has nothing for it to read.
use gpui::*;
use std::{cell::RefCell, collections::HashMap, rc::Rc};

/// The room a row takes in the list: the space above it (the list's gap and
/// the row's own margin) and its height.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(in crate::tmux_snapshot) struct Space {
    pub lead: Pixels,
    pub height: Pixels,
}

/// The list's gap between rows. A placeholder takes the rest of its row's
/// lead as its own margin.
const GAP: Pixels = px(2.);

/// The remembered sizes, shared with the measuring element.
#[derive(Clone, Default)]
pub(in crate::tmux_snapshot) struct RowWindow(Rc<RefCell<Inner>>);

#[derive(Default)]
struct Inner {
    sizes: HashMap<u64, Space>,
    /// What the sizes were measured under: the theme, the rem size, the
    /// scale factor and the list's width.
    context: Option<u64>,
}

/// What a render planned against: the list's visible height and offset.
#[derive(Clone, Copy, PartialEq)]
struct Planned {
    height: Pixels,
    offset: Pixels,
}

impl RowWindow {
    /// For each row (in list order, after the Home row), `None` to build it
    /// or the space of the placeholder that stands for it. `every` builds
    /// every row (assistive technology); `keep` says which rows stay built.
    pub(in crate::tmux_snapshot) fn plan(
        &self,
        shapes: &[u64],
        context: u64,
        list: &ScrollHandle,
        every: bool,
        keep: impl Fn(usize) -> bool,
    ) -> Vec<Option<Space>> {
        let mut inner = self.0.borrow_mut();
        if inner.context.replace(context) != Some(context) {
            inner.sizes.clear();
        }
        if every {
            return vec![None; shapes.len()];
        }
        let view = list.bounds();
        let start = list
            .bounds_for_item(0)
            .map(|home| home.bottom() - view.top());
        let spaces: Vec<_> = shapes
            .iter()
            .map(|shape| inner.sizes.get(shape).copied())
            .collect();
        plan(&spaces, start, view.size.height, list.offset().y, keep)
    }

    /// An element with no size, laid out after the list, that measures each
    /// row as laid out on this frame. When the list's visible part is not
    /// the one the render planned for (a resize, a jump), `owner` renders
    /// again on the next frame, so rows that came into view are built.
    pub(in crate::tmux_snapshot) fn measure(
        &self,
        shapes: Vec<u64>,
        list: &ScrollHandle,
        windowed: bool,
        owner: EntityId,
    ) -> AnyElement {
        let window_rows = self.clone();
        let list = list.clone();
        let planned = Planned {
            height: list.bounds().size.height,
            offset: list.offset().y,
        };
        canvas(
            move |_, window, _| {
                let bounds: Vec<_> = (0..=shapes.len())
                    .map_while(|index| list.bounds_for_item(index))
                    .collect();
                learn(&mut window_rows.0.borrow_mut().sizes, &shapes, &bounds);
                let now = Planned {
                    height: list.bounds().size.height,
                    offset: list.offset().y,
                };
                if windowed && moved(planned, now) {
                    window.on_next_frame(move |_, cx| cx.notify(owner));
                }
            },
            |_, _, _, _| {},
        )
        .absolute()
        .size_0()
        .into_any_element()
    }
}

fn moved(planned: Planned, now: Planned) -> bool {
    (planned.height - now.height).abs() > px(0.5) || (planned.offset - now.offset).abs() > px(0.5)
}

/// The rows to build. `spaces` are the remembered sizes (`None`: never
/// measured), `start` where the first row's lead begins in the list's
/// unscrolled coordinates (the Home row's bottom), `height` the list's
/// visible height and `offset` its scroll offset (zero or less).
pub(in crate::tmux_snapshot) fn plan(
    spaces: &[Option<Space>],
    start: Option<Pixels>,
    height: Pixels,
    offset: Pixels,
    keep: impl Fn(usize) -> bool,
) -> Vec<Option<Space>> {
    let (Some(mut at), true) = (start, height > px(0.)) else {
        return vec![None; spaces.len()];
    };
    let margin = height / 4.;
    let from = px(0.) - offset - margin;
    let to = px(0.) - offset + height + margin;
    let mut known = true;
    spaces
        .iter()
        .enumerate()
        .map(|(index, space)| {
            let Some(space) = space.filter(|_| known) else {
                known = false;
                return None;
            };
            let top = at + space.lead;
            at = top + space.height;
            let far = at < from || top > to;
            (far && !keep(index)).then_some(space)
        })
        .collect()
}

/// The sizes of the rows as laid out: `bounds[0]` is the Home row and
/// `bounds[i + 1]` row `i`. Only the rows shown now are remembered.
pub(in crate::tmux_snapshot) fn learn(
    sizes: &mut HashMap<u64, Space>,
    shapes: &[u64],
    bounds: &[Bounds<Pixels>],
) {
    if bounds.len() != shapes.len() + 1 {
        return;
    }
    *sizes = shapes
        .iter()
        .zip(bounds.windows(2))
        .map(|(shape, pair)| {
            let space = Space {
                lead: pair[1].top() - pair[0].bottom(),
                height: pair[1].size.height,
            };
            (*shape, space)
        })
        .collect();
}

/// The box that stands for a far row: its height, and its margin above.
pub(in crate::tmux_snapshot) fn placeholder(space: Space) -> Div {
    div()
        .w_full()
        .flex_shrink_0()
        .mt(space.lead - GAP)
        .h(space.height)
}

#[cfg(test)]
#[path = "window_plan_tests.rs"]
mod tests;
