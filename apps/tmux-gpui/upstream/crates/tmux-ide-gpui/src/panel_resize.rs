//! Side panels resize the way the sidebar does: drag the edge that faces the
//! content, double-click it to go back to the default width. A panel never
//! takes more than `MAX_SHARE` of the window, however wide it was made, so a
//! narrow window keeps room for what the panel sits next to.
use gpui::{prelude::*, *};

/// How wide the grabbable edge is, laid over the panel's border.
const HANDLE: f32 = 6.;
/// The tint a resizable edge shows under the pointer, the sidebar's first.
pub(crate) const RESIZE_HOVER: u32 = 0x78a9ff44;
/// The share of the surrounding space a panel may take.
const MAX_SHARE: f32 = 0.6;
/// A stored width beyond this is not a real panel.
const MAX_WIDTH: f32 = 4096.;

/// Which side of its content a panel sits on; its handle is on the edge
/// facing the content.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Side {
    Left,
    Right,
}

/// The panel a drag resizes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PanelDrag {
    /// The notes beside a review; they share their width with a page's.
    ReviewNotes,
    /// The notes beside an annotated page; only builds that show pages
    /// annotate them.
    #[cfg(any(target_os = "macos", windows))]
    PageNotes,
    /// The settings window's section list.
    SettingsNavigation,
    /// The line between a side-by-side diff's halves.
    DiffSides,
    /// The review's list of changed files.
    ReviewFiles,
}

/// The notes panel beside a review or an annotated page.
pub(crate) const NOTES: PanelWidth = PanelWidth::new(300., 220.);
/// The review's list of changed files.
pub(crate) const REVIEW_FILES: PanelWidth = PanelWidth::new(240., 160.);
/// The settings window's section list.
pub(crate) const SETTINGS_NAVIGATION: PanelWidth = PanelWidth::new(184., 150.);

/// A panel's width: its default until the user drags it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct PanelWidth {
    chosen: Option<f32>,
    default: f32,
    min: f32,
    /// Changed since it was last saved.
    unsaved: bool,
}

impl PanelWidth {
    pub(crate) const fn new(default: f32, min: f32) -> Self {
        Self {
            chosen: None,
            default,
            min,
            unsaved: false,
        }
    }

    /// The width the user chose, to save; `None` follows the default.
    pub(crate) fn chosen(&self) -> Option<f32> {
        self.chosen
    }

    /// Restores a saved width; anything unusable keeps the default.
    pub(crate) fn restore(&mut self, chosen: Option<f32>) {
        self.chosen = chosen
            .filter(|width| width.is_finite() && *width > 0.)
            .map(|width| width.clamp(self.min, MAX_WIDTH));
    }

    /// The width to draw beside `available` pixels of space: the chosen or
    /// default width, never more than `MAX_SHARE` of the space, and never
    /// less than the minimum while the space allows it. Space not known yet
    /// (`0`) caps nothing.
    pub(crate) fn width(&self, available: f32) -> f32 {
        let width = self.chosen.unwrap_or(self.default);
        if available <= 0. {
            return width;
        }
        width
            .min(available * MAX_SHARE)
            .max(self.min.min(available))
    }

    /// Follows the pointer at `x` while the panel, laid out at `bounds`, is
    /// dragged by its edge. Whether the width changed.
    pub(crate) fn drag(&mut self, side: Side, bounds: Bounds<Pixels>, x: Pixels) -> bool {
        let width = match side {
            Side::Right => bounds.right() - x,
            Side::Left => x - bounds.left(),
        };
        let width = f32::from(width).clamp(self.min, MAX_WIDTH);
        if self.chosen == Some(width) {
            return false;
        }
        self.chosen = Some(width);
        self.unsaved = true;
        true
    }

    /// Back to the default width.
    pub(crate) fn reset(&mut self) {
        self.chosen = None;
        self.unsaved = true;
    }

    /// Whether the width changed since this last answered, so a drag is
    /// saved once, when it ends.
    pub(crate) fn take_unsaved(&mut self) -> bool {
        std::mem::take(&mut self.unsaved)
    }
}

/// The edge to drag, laid over the panel's inner edge; put it inside the
/// panel, which must be `relative()` and listen for `on_drag_move`. `reset`
/// runs on a double-click.
pub(crate) fn handle(
    id: &'static str,
    side: Side,
    drag: PanelDrag,
    reset: impl Fn(&MouseDownEvent, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    let handle = grip(id, drag, reset);
    // Inside the panel's edge: a panel that slides open clips its overflow.
    match side {
        Side::Right => handle.left_0(),
        Side::Left => handle.right_0(),
    }
}

/// A line to drag at `x` within its `relative()` container, such as the one
/// between a side-by-side diff's halves.
pub(crate) fn divider(
    id: &'static str,
    x: Pixels,
    drag: PanelDrag,
    reset: impl Fn(&MouseDownEvent, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    grip(id, drag, reset).left(x - px(HANDLE / 2.))
}

/// The grabbable strip both share: the sidebar's cursor and hover tint, a
/// drag of `drag`, and `reset` on a double-click.
fn grip(
    id: &'static str,
    drag: PanelDrag,
    reset: impl Fn(&MouseDownEvent, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    div()
        .id(id)
        .debug_selector(move || id.into())
        .absolute()
        .top_0()
        .h_full()
        .w(px(HANDLE))
        .cursor(CursorStyle::ResizeLeftRight)
        .hover(|style| style.bg(rgba(RESIZE_HOVER)))
        .on_mouse_down(MouseButton::Left, move |event, window, cx| {
            cx.stop_propagation();
            if event.click_count == 2 {
                reset(event, window, cx);
            }
        })
        .on_drag(drag, |_, _, _, cx| cx.new(|_| EmptyView))
}

impl crate::HerdrWindow {
    /// The notes panels' width in this window, for a page's panel, which
    /// slides open at this width; only builds that show pages have one.
    #[cfg(any(target_os = "macos", windows))]
    pub(crate) fn notes_panel_width(&self) -> f32 {
        self.notes_width.width(self.viewport_width)
    }

    /// The window's own width for a panel `drag` resizes, and the side the
    /// panel sits on; `None` for a panel another window owns.
    fn window_panel(&mut self, drag: PanelDrag) -> Option<(&mut PanelWidth, Side)> {
        match drag {
            PanelDrag::ReviewNotes => Some((&mut self.notes_width, Side::Right)),
            #[cfg(any(target_os = "macos", windows))]
            PanelDrag::PageNotes => Some((&mut self.notes_width, Side::Right)),
            PanelDrag::ReviewFiles => Some((&mut self.review_files_width, Side::Left)),
            PanelDrag::SettingsNavigation | PanelDrag::DiffSides => None,
        }
    }

    /// `window_panel` to read while drawing.
    fn panel_at(&self, drag: PanelDrag) -> Option<(PanelWidth, Side)> {
        match drag {
            PanelDrag::ReviewNotes => Some((self.notes_width, Side::Right)),
            #[cfg(any(target_os = "macos", windows))]
            PanelDrag::PageNotes => Some((self.notes_width, Side::Right)),
            PanelDrag::ReviewFiles => Some((self.review_files_width, Side::Left)),
            PanelDrag::SettingsNavigation | PanelDrag::DiffSides => None,
        }
    }

    /// Makes a window panel resizable by the edge facing its content. Its
    /// width is saved with the window's chrome when a drag ends; the review's
    /// and a page's notes share one. `share`, when given, caps the panel at
    /// that share of the row it sits in, so panels inside a narrow group
    /// leave their content room.
    pub(crate) fn resizable_panel(
        &self,
        panel: Stateful<Div>,
        id: &'static str,
        drag: PanelDrag,
        share: Option<f32>,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let Some((width, side)) = self.panel_at(drag) else {
            return panel;
        };
        let width = width.width(self.viewport_width);
        let save =
            move |this: &mut Self, _: &MouseUpEvent, _: &mut Window, _: &mut Context<Self>| {
                if this
                    .window_panel(drag)
                    .is_some_and(|(width, _)| width.take_unsaved())
                {
                    this.save_chrome();
                }
            };
        panel
            .relative()
            .w(px(width))
            .when_some(share, |panel, share| panel.max_w(relative(share)))
            .on_drag_move(
                cx.listener(move |this, event: &DragMoveEvent<PanelDrag>, _, cx| {
                    if *event.drag(cx) == drag
                        && this.window_panel(drag).is_some_and(|(width, side)| {
                            width.drag(side, event.bounds, event.event.position.x)
                        })
                    {
                        cx.notify();
                    }
                }),
            )
            .on_mouse_up(MouseButton::Left, cx.listener(save))
            .on_mouse_up_out(MouseButton::Left, cx.listener(save))
            .child(handle(
                id,
                side,
                drag,
                cx.listener(move |this, _, _, cx| {
                    let reset = this.window_panel(drag).is_some_and(|(width, _)| {
                        width.reset();
                        width.take_unsaved()
                    });
                    if reset {
                        this.save_chrome();
                    }
                    cx.notify();
                }),
            ))
    }
}

#[cfg(test)]
mod tests;
