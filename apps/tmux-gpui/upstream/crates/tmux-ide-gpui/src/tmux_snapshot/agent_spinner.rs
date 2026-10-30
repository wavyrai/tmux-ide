//! The working-agent spinner, drawn outside `SnapshotView`.
//!
//! GPUI re-renders every ancestor of a notified view, and always renders an
//! uncached window root. So the spinner frames cannot live inside
//! `SnapshotView` without repainting the whole window on every tick. Instead
//! `SnapshotView` is a cached child of a thin window [`Root`], each working
//! indicator reserves its glyph slot and publishes where it was painted, and
//! the [`Spinner`] overlay (a sibling of `SnapshotView`) owns the 80 ms tick and
//! paints the frames into those slots. A tick notifies only the overlay.
use super::{SnapshotView, agent_indicator::FRAMES};
use gpui::{prelude::*, *};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    time::Duration,
};

pub(super) const TICK: Duration = Duration::from_millis(80);

#[derive(Clone)]
struct Slot {
    origin: Point<Pixels>,
    mask: ContentMask<Pixels>,
    font: Font,
    font_size: Pixels,
    line_height: Pixels,
    color: Hsla,
}

#[derive(Default)]
struct Shared {
    slots: RefCell<Vec<Slot>>,
    frame: Cell<usize>,
    active: Cell<bool>,
    spinner: RefCell<Option<WeakEntity<Spinner>>>,
    /// Frames painted, one per slot, so tests can see a tick reach the screen.
    #[cfg(test)]
    painted: RefCell<Vec<usize>>,
}

/// `SnapshotView`'s side of the spinner: the slots its last paint reserved.
#[derive(Clone, Default)]
pub(super) struct Slots(Rc<Shared>);

impl Slots {
    /// A new `SnapshotView` render repaints every indicator, so its slots restart.
    pub(super) fn begin_render(&self) {
        self.0.slots.borrow_mut().clear();
    }
    /// Whether an overlay will paint this view's frames.
    pub(super) fn attached(&self) -> bool {
        self.spinner().is_some()
    }
    pub(super) fn frame(&self) -> usize {
        self.0.frame.get()
    }
    pub(super) fn active(&self) -> bool {
        self.0.active.get()
    }
    /// Records whether the view allows motion, and starts or stops the tick.
    pub(super) fn sync(&self, active: bool, cx: &mut App) {
        self.0.active.set(active);
        if let Some(spinner) = self.spinner() {
            spinner.update(cx, |spinner, cx| spinner.reconcile(cx));
        }
    }
    /// Called from the indicator's paint: the glyph box at `bounds` in the
    /// current text style is a slot the overlay animates.
    pub(super) fn reserve(&self, bounds: Bounds<Pixels>, window: &Window) {
        let mask = window.content_mask();
        let visible = bounds.intersect(&mask.bounds);
        if visible.size.width <= px(0.) || visible.size.height <= px(0.) {
            return;
        }
        let style = window.text_style();
        let rem = window.rem_size();
        self.0.slots.borrow_mut().push(Slot {
            origin: bounds.origin,
            mask,
            font: style.font(),
            font_size: style.font_size.to_pixels(rem),
            line_height: style.line_height_in_pixels(rem),
            color: style.color,
        });
    }
    #[cfg(test)]
    pub(super) fn colors(&self) -> Vec<Hsla> {
        self.0
            .slots
            .borrow()
            .iter()
            .map(|slot| slot.color)
            .collect()
    }
    /// The frame each slot was painted with since the last call.
    #[cfg(test)]
    pub(super) fn take_painted(&self) -> Vec<usize> {
        std::mem::take(&mut *self.0.painted.borrow_mut())
    }
    /// The overlay view a tick must invalidate.
    #[cfg(test)]
    pub(super) fn overlay(&self) -> Option<Entity<Spinner>> {
        self.spinner()
    }
    fn reserved(&self) -> bool {
        !self.0.slots.borrow().is_empty()
    }
    fn spinner(&self) -> Option<Entity<Spinner>> {
        self.0
            .spinner
            .borrow()
            .as_ref()
            .and_then(WeakEntity::upgrade)
    }
    fn paint(&self, window: &mut Window, cx: &mut App) {
        let glyph = SharedString::new_static(FRAMES[self.frame() % FRAMES.len()]);
        for slot in self.0.slots.borrow().iter() {
            let run = TextRun {
                len: glyph.len(),
                font: slot.font.clone(),
                color: slot.color,
                background_color: None,
                underline: None,
                strikethrough: None,
            };
            let line = window
                .text_system()
                .shape_line(glyph.clone(), slot.font_size, &[run], None);
            window.with_content_mask(Some(slot.mask), |window| {
                match line.paint(
                    slot.origin,
                    slot.line_height,
                    TextAlign::Left,
                    None,
                    window,
                    cx,
                ) {
                    #[cfg(test)]
                    Ok(()) => self.0.painted.borrow_mut().push(self.frame()),
                    #[cfg(not(test))]
                    Ok(()) => {}
                    Err(error) => eprintln!("tmux-ide: agent spinner paint failed: {error}"),
                }
            });
        }
    }
}

/// The overlay that owns the tick. It runs only while the window is visible,
/// the view allows motion and some working indicator was painted.
pub(super) struct Spinner {
    slots: Slots,
    visible: bool,
    ticking: bool,
    task: Option<Task<()>>,
    _visibility: Subscription,
}

impl Spinner {
    pub(super) fn new(slots: Slots, window: &mut Window, cx: &mut Context<Self>) -> Self {
        *slots.0.spinner.borrow_mut() = Some(cx.weak_entity());
        let visibility = cx.observe_window_visibility(window, |spinner, visibility, _, cx| {
            spinner.visible = visibility.is_visible();
            spinner.reconcile(cx);
        });
        Self {
            slots,
            visible: window.is_visible(),
            ticking: false,
            task: None,
            _visibility: visibility,
        }
    }
    fn should_run(&self) -> bool {
        self.visible && self.slots.active() && self.slots.reserved()
    }
    #[cfg(test)]
    pub(super) fn ticking(&self) -> bool {
        self.ticking
    }
    fn reconcile(&mut self, cx: &mut Context<Self>) {
        if !self.should_run() {
            self.ticking = false;
            self.task = None;
            self.slots.0.frame.set(0);
            return;
        }
        if self.ticking {
            return;
        }
        self.ticking = true;
        self.task = Some(cx.spawn(async move |spinner, cx| {
            loop {
                cx.background_executor().timer(TICK).await;
                match spinner.update(cx, |spinner, cx| spinner.advance(cx)) {
                    Ok(true) => {}
                    _ => break,
                }
            }
        }));
    }
    fn advance(&mut self, cx: &mut Context<Self>) -> bool {
        if !self.should_run() {
            self.ticking = false;
            self.slots.0.frame.set(0);
            return false;
        }
        self.slots
            .0
            .frame
            .set((self.slots.frame() + 1) % FRAMES.len());
        cx.notify();
        true
    }
}

impl Render for Spinner {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let slots = self.slots.clone();
        canvas(
            |_, _, _| (),
            move |_, _, window, cx| slots.paint(window, cx),
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full()
    }
}

/// The window root: `SnapshotView` cached, the spinner overlay above it.
pub(super) struct Root {
    snapshot: Entity<SnapshotView>,
    spinner: Entity<Spinner>,
}

impl Render for Root {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .relative()
            .size_full()
            .child(
                self.snapshot
                    .clone()
                    .cached(StyleRefinement::default().size_full()),
            )
            .child(self.spinner.clone())
    }
}

/// Mounts `snapshot` as the window content with its spinner overlay.
pub(super) fn window_root(
    snapshot: Entity<SnapshotView>,
    window: &mut Window,
    cx: &mut App,
) -> Entity<Root> {
    let slots = snapshot.read(cx).agent_animation.clone();
    let spinner = cx.new(|cx| Spinner::new(slots, window, cx));
    cx.new(|_| Root { snapshot, spinner })
}

#[cfg(test)]
#[path = "agent_spinner_tests.rs"]
mod tests;
