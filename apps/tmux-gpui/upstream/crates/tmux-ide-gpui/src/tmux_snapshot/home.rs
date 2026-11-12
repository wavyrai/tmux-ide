//! Catalog-backed Home. No daemon queries or invented activity in the render path.
use super::{SnapshotView, browser, browser_ui::Selection, controls as native_controls, design};
use bezel_theme::{TextStyle, Typeset};
use bezel_ui::widgets::{Content as _, Scaffolding, Status as _};
use gpui::{prelude::*, *};
mod action_focus;
mod aside_link;
pub(super) mod filters;
pub(super) mod fleet;
pub(super) mod fleet_nav;
pub(super) mod fleet_rows;
pub(super) mod machine_filter;
mod preferences;
pub(super) mod recovery;
mod row_root;
pub(super) mod rows_window;

const SPACE: f32 = bezel_theme::Theme::SPACE;
/// The page column's width: the table's (#746), with the filter row over
/// it, so the table's values sit near its names, plus the page column's own
/// 24 pt sides, so the table itself gets the whole width.
const PAGE_MAX: f32 = fleet::TABLE_MAX + 2. * PAGE_SIDE;
/// Bezel's `page_column` side padding.
const PAGE_SIDE: f32 = 24.;
/// The Browse sessions field's width in the header (#746 v3).
const BROWSE_WIDTH: f32 = 260.;
/// The alpha of `popover::key_cap`'s fill.
const KEY_CAP_FILL: f32 = 0.05;
/// The alpha of the status strips' tinted fill.
const STRIP_FILL: f32 = 0.06;

fn pack(color: Hsla) -> u32 {
    u32::from(Rgba::from(color)) >> 8
}

/// The Browse sessions field's fill: Bezel's sunken code-and-field wash over
/// the canvas (#746 v3: no border, no lift).
pub(super) fn field(bezel: &bezel_theme::Theme, canvas: u32) -> Hsla {
    bezel_theme::flatten(bezel.code_wash, rgb(canvas).into())
}

/// What Home's text sits on: the opaque canvas, the field over it, the hover
/// wash over each, the selected wash over the canvas (a hovered row takes
/// the hover fill in place of its own), and a key cap over the canvas.
fn plates(bezel: &bezel_theme::Theme, canvas: u32) -> [u32; 6] {
    let canvas_color: Hsla = rgb(canvas).into();
    let field = field(bezel, canvas);
    [
        canvas,
        pack(field),
        pack(bezel_theme::flatten(bezel.element_hover, canvas_color)),
        pack(bezel_theme::flatten(bezel.element_hover, field)),
        pack(bezel_theme::flatten(bezel.card_selected_bg(), canvas_color)),
        pack(bezel_theme::flatten(bezel.ink(KEY_CAP_FILL), canvas_color)),
    ]
}

/// What a status strip of `tone` paints its message on: the tone's wash over
/// the canvas.
pub(super) fn strip_plate(tone: Hsla, canvas: u32) -> u32 {
    pack(bezel_theme::flatten(
        tone.opacity(STRIP_FILL),
        rgb(canvas).into(),
    ))
}

/// Bezel's palette for Home, with `text` and `text_muted` inked to read at
/// 4.5:1 on every plate Home paints text on. Bezel's own roles are made for
/// the window chrome; Home sits on its own canvas, which is not the terminal's
/// background, and Bezel's translucent muted text can drop under 4.5:1 there.
/// `danger_muted` and `warning_muted`, the strips' text, are inked opaque on
/// their strip's wash; `danger_muted` also on the bare canvas, where error
/// rows sit. The 4.6 target leaves room for the 8-bit rounding of the plates,
/// as the chrome's ink tiers do.
pub(super) fn palette(theme: &crate::config::Theme, canvas: u32) -> bezel_theme::Theme {
    thread_local! {
        /// The last theme and canvas Home was inked for, and the result:
        /// every row and chip asks, and the answer changes only with the
        /// appearance (perf plan, finding 2).
        static LAST: std::cell::RefCell<Option<(crate::config::Theme, u32, bezel_theme::Theme)>> =
            const { std::cell::RefCell::new(None) };
    }
    if let Some(inked) = LAST.with(|last| {
        last.borrow()
            .as_ref()
            .filter(|(source, plate, _)| source == theme && *plate == canvas)
            .map(|(_, _, inked)| inked.clone())
    }) {
        return inked;
    }
    let inked = ink_home(theme, canvas);
    LAST.with(|last| *last.borrow_mut() = Some((theme.clone(), canvas, inked.clone())));
    inked
}

fn ink_home(theme: &crate::config::Theme, canvas: u32) -> bezel_theme::Theme {
    /// Foreground, muted, surface, background, high contrast, canvas.
    type Key = (u32, u32, u32, u32, bool, u32);
    thread_local! {
        static CACHE: std::cell::RefCell<std::collections::HashMap<Key, [u32; 4]>> =
            Default::default();
    }
    let mut bezel = design::palette(theme);
    let key = (
        theme.foreground,
        theme.muted,
        theme.surface,
        theme.background,
        theme.contrast == crate::contrast::Contrast::High,
        canvas,
    );
    let [text, muted, danger, warning] = CACHE.with(|cache| {
        if let Some(&inked) = cache.borrow().get(&key) {
            return inked;
        }
        let plates = plates(&bezel, canvas);
        let opaque = |color: Hsla| pack(Hsla { a: 1.0, ..color });
        let inked = [
            crate::contrast::ink(theme.foreground, &plates, 4.6),
            crate::contrast::ink(theme.muted, &plates, 4.6),
            crate::contrast::ink(
                opaque(bezel.danger_muted),
                &[strip_plate(bezel.danger, canvas), canvas],
                4.6,
            ),
            crate::contrast::ink(
                opaque(bezel.warning_muted),
                &[strip_plate(bezel.warning, canvas)],
                4.6,
            ),
        ];
        let mut cache = cache.borrow_mut();
        // A theme inks once per canvas; theme switching starts over rather
        // than growing without bound.
        if cache.len() > 64 {
            cache.clear();
        }
        cache.insert(key, inked);
        inked
    });
    bezel.text = rgb(text).into();
    bezel.text_muted = rgb(muted).into();
    bezel.danger_muted = rgb(danger).into();
    bezel.warning_muted = rgb(warning).into();
    bezel
}

/// How Home shows its status line: a strip for a failure, the page subtitle
/// otherwise.
#[derive(Clone, Copy, Debug, PartialEq)]
enum StatusTone {
    Normal,
    Warning,
    Error,
}

fn status_tone(state: &browser::State, connected: bool) -> StatusTone {
    match state.local_setup.as_ref().filter(|_| connected) {
        Some(setup) if setup.phase == browser::local_setup::Phase::Failed => StatusTone::Error,
        Some(_) => StatusTone::Normal,
        None if state.home_phase == browser::HomePhase::Unavailable
            || state.home_fault
            || state.home_notice.is_some() =>
        {
            StatusTone::Warning
        }
        None => StatusTone::Normal,
    }
}

/// Before the first browser publication, absence of a catalog is not an empty catalog.
pub(super) fn initial_state() -> browser::State {
    browser::State {
        home_phase: browser::HomePhase::Loading,
        status: "Loading sessions…".into(),
        ..Default::default()
    }
}

fn live(state: &browser::State, connected: bool) -> bool {
    connected && state.home_phase == browser::HomePhase::Live
}
fn status_message(state: &browser::State, connected: bool) -> String {
    if connected && let Some(setup) = &state.local_setup {
        return setup.phase.guidance().into();
    }
    // Only a fault, which the user must act on, outranks a pane-limit notice.
    // A reconnect is the footer slot's: its words never reach Home's strip,
    // and the notice stays through it (r1, quiet reconnect).
    match &state.home_notice {
        Some(notice) if !state.home_fault => crate::notifications::safe_text(notice, 480),
        _ => crate::notifications::safe_text(&state.status, 240),
    }
}
fn current(state: &browser::State, connected: bool, request: u64, captured: u64, id: &str) -> bool {
    state.surface == browser::Surface::Home
        && live(state, connected)
        && request == captured
        && state.sessions.iter().any(|session| session.id == id)
}

impl SnapshotView {
    /// [`palette`] for this view's theme and canvas.
    pub(super) fn home_palette(&self) -> bezel_theme::Theme {
        palette(&self.theme(), self.canvas())
    }
    fn home_select(&mut self, request: u64, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if current(
            &self.browser_state,
            self.browser_commands.is_some(),
            self.browser_request,
            request,
            id,
        ) {
            self.select(Selection::Session(id.into()), window, cx);
        }
    }
    fn home_action_current(&self, request: u64) -> bool {
        self.browser_state.surface == browser::Surface::Home
            && self.browser_commands.is_some()
            && self.browser_request == request
            && self.picker.is_none()
            && self.new_session.is_none()
            && self.pane_actions.is_none()
    }
    pub(super) fn home_refresh(
        &mut self,
        request: u64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.home_action_current(request) {
            return;
        }
        if let Some(setup) = &self.browser_state.local_setup {
            if setup.phase == browser::local_setup::Phase::Running {
                return;
            }
            if setup.phase.actionable() {
                if !self.marked.is_empty()
                    || !self.presence.ready()
                    || self.browser_state.request != request
                {
                    return;
                }
                if self.browser_commands.as_ref().is_some_and(|sender| {
                    sender
                        .try_send(browser::Command::LocalSetup { request })
                        .is_ok()
                }) {
                    self.browser_state.local_setup = Some(browser::local_setup::Setup {
                        phase: browser::local_setup::Phase::Running,
                    });
                } else {
                    self.browser_state.local_setup = Some(browser::local_setup::Setup {
                        phase: browser::local_setup::Phase::Failed,
                    });
                    self.browser_state.status =
                        "Local setup request could not be sent. Try again.".into();
                }
                cx.notify();
                return;
            }
        }
        self.select(Selection::Refresh, window, cx);
    }
    pub(super) fn home_render(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        self.refresh_new_session(cx);
        self.prepare_home_filter(cx);
        let (now, reduced) = (cx.background_executor().now(), cx.reduce_motion());
        if let Some(controls) = self.home_filter.as_mut() {
            let machines = super::motion::home_machines(&self.browser_state);
            controls.motion.observe(&machines, now);
            if controls.motion.settle(now, reduced) {
                window.request_animation_frame();
            }
        }
        if self.browser_state.appearance.is_none()
            && self.home_action_current(self.browser_request)
            && self.home_action_index(window) == Some(1)
        {
            self.terminal_focus.focus(window, cx);
        }
        let theme = self.theme();
        let bezel = self.home_palette();
        let request = self.browser_request;
        let connected = self.browser_commands.is_some();
        let setup_phase = self
            .browser_state
            .local_setup
            .as_ref()
            .map(|setup| setup.phase);
        let refresh_label = setup_phase.map_or("Refresh sessions", |phase| phase.label());
        let setup_running = setup_phase == Some(browser::local_setup::Phase::Running);
        let is_live = live(&self.browser_state, connected)
            || (connected
                && self.browser_state.fleet.as_ref().is_some_and(|f| {
                    f.groups
                        .iter()
                        .any(|g| g.state == browser::fleet::Phase::Ready)
                }));
        let canvas = self.canvas();
        // One line over the table: Home's title, Browse as a field, the
        // agents that need input, then Refresh with its words, and New
        // session as the one primary button, in the accent (#705, #746).
        // Theme is in the sidebar's footer, the menu bar and F5.
        let mut actions = div()
            .tab_group()
            .flex_1()
            .min_w_0()
            .max_w(px(fleet::TABLE_MAX))
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(SPACE));
        if connected {
            let action_focus = self
                .home_filter
                .as_ref()
                .map(|controls| controls.actions.clone());
            let fill = field(&bezel, canvas);
            let hover = bezel_theme::flatten(bezel.element_hover, fill);
            actions = actions
                .child(
                    div()
                        .id("home-browse")
                        .debug_selector(|| "home-browse".into())
                        .accessibility_id("home-browse")
                        .role(Role::Button)
                        .aria_label("Browse sessions")
                        .aria_keyshortcuts("Meta+K")
                        .w(px(BROWSE_WIDTH))
                        .min_w_0()
                        .h(px(28.))
                        .px(px(8.))
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .rounded(px(8.))
                        .bg(fill)
                        .cursor_pointer()
                        .hover(move |s| s.bg(hover))
                        .child(
                            bezel_ui::icons::icon(bezel_ui::icons::Icon::asset("icons/search.svg"))
                                .size(px(14.))
                                .flex_none()
                                .text_color(bezel.text_muted),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .text_style(TextStyle::Body)
                                .text_color(bezel.text_muted)
                                .children(design::ink_probe(|| "home-browse".into()))
                                .child("Browse sessions…"),
                        )
                        .child(
                            bezel_ui::popover::kbd_hint(&bezel, "⌘K")
                                .text_color(bezel.text_muted)
                                .children(design::ink_probe(|| "home-browse-key".into())),
                        )
                        .when_some(action_focus.as_ref(), |control, focus| {
                            action_focus::focus_control(
                                control,
                                &focus[0],
                                0,
                                theme.foreground,
                                canvas,
                            )
                        })
                        .on_click(cx.listener(move |view, _, window, cx| {
                            if view.home_action_current(request) {
                                view.open_picker(window, cx);
                            }
                        })),
                )
                .children(self.home_agent_pill(cx))
                .child(div().flex_1())
                .child(
                    native_controls::action_button_on(
                        "tmux-home-refresh",
                        Some(setup_phase.map_or("Refresh", |phase| phase.label())),
                        refresh_label,
                        native_controls::Icon::Refresh,
                        if setup_running {
                            native_controls::ButtonStyle::Unavailable
                        } else {
                            native_controls::ButtonStyle::Quiet
                        },
                        &bezel,
                    )
                    .when_some(action_focus.as_ref(), |control, focus| {
                        action_focus::focus_control(
                            control,
                            &focus[2],
                            2,
                            theme.ink(theme.primary()),
                            canvas,
                        )
                    })
                    .on_click(cx.listener(move |this, _, window, cx| {
                        cx.stop_propagation();
                        this.home_refresh(request, window, cx);
                    })),
                );
        }
        if !connected {
            actions = actions.child(div().flex_1());
        }
        actions = actions.child(self.local_session_action(cx).when(
            self.local_session_available(),
            |control| {
                control.when_some(self.home_filter.as_ref(), |control, filters| {
                    action_focus::focus_control(
                        control,
                        &filters.actions[3],
                        3,
                        theme.foreground,
                        canvas,
                    )
                })
            },
        ));
        let mut body = bezel
            .page_column()
            .id("tmux-home-content")
            .min_w_0()
            .w_full()
            .max_w(px(PAGE_MAX))
            .bg(rgb(canvas))
            .text_color(bezel.text)
            .text_style(TextStyle::Body)
            .children(design::ink_probe(|| "home-text".into()))
            .child(
                div()
                    .debug_selector(|| "home-header".into())
                    .w_full()
                    .min_w_0()
                    .flex()
                    .items_center()
                    .gap(px(SPACE * 2.))
                    .child(
                        div()
                            .debug_selector(|| "home-title".into())
                            .flex_none()
                            .text_style(TextStyle::Title2)
                            .font_weight(FontWeight::SEMIBOLD)
                            .children(design::ink_probe(|| "home-title".into()))
                            .child("Home"),
                    )
                    .child(actions),
            );
        // The status slot (#746): under the toolbar, over the filter row,
        // left-aligned with Home's title and spanning the column. A quiet
        // status line (Home's reconnecting line and its Retry) or a warning
        // or error strip for a fault (home_fault); then guidance and the
        // new-session form. A live Home shows a status line only while it
        // reconnects or has stopped.
        // A reconnect or the first load is the footer slot's (r1, r5): no line here.
        let waiting = super::connection::waiting(&self.browser_state, connected).is_some();
        // r3: what only the user can fix is one card, in place of the line.
        let act = super::connection::card(&self.browser_state, connected);
        if let Some(card) = act.clone() {
            body = body.child(self.act_card(card, cx));
        }
        // The pane-limit notice is always loud: it shows beside a card too.
        let notice = self.browser_state.home_notice.as_ref().filter(|_| is_live);
        if (act.is_some() && notice.is_some())
            || (act.is_none()
                && ((connected && setup_phase.is_some())
                    || (!is_live && !waiting && !self.browser_state.status.is_empty())
                    || (is_live && self.browser_state.home_fault)
                    || notice.is_some()))
        {
            let status = match notice.filter(|_| act.is_some()) {
                Some(notice) => crate::notifications::safe_text(notice, 480),
                None => status_message(&self.browser_state, connected),
            };
            let line = match status_tone(&self.browser_state, connected) {
                StatusTone::Normal => bezel
                    .page_subtitle(status)
                    .debug_selector(|| "home-status-subtitle".into()),
                StatusTone::Warning => bezel
                    .warning_strip(status)
                    .text_color(bezel.warning_muted)
                    .debug_selector(|| "home-status-warning".into()),
                StatusTone::Error => bezel
                    .error_strip(status)
                    .text_color(bezel.danger_muted)
                    .debug_selector(|| "home-status-error".into()),
            };
            let line = line
                .w_full()
                .children(design::ink_probe(|| "home-status".into()));
            // The slot fades in over FADE_QUICK and leaves at once (#761).
            body = body.child(bezel_motion::fade_quick("home-status-in", line));
        }
        if self.home_diagnostics_available() {
            body = body.child(
                div().w_full().flex().justify_start().child(
                    native_controls::button_on(
                        "home-copy-diagnostics",
                        Some("Copy diagnostics"),
                        "Copy safe error details",
                        native_controls::Icon::Copy,
                        &bezel,
                    )
                    .when_some(self.home_filter.as_ref(), |control, filter| {
                        action_focus::focus_control(
                            control,
                            &filter.actions[4],
                            4,
                            theme.foreground,
                            canvas,
                        )
                    })
                    .on_click(cx.listener(move |view, _, window, cx| {
                        cx.stop_propagation();
                        view.home_copy_diagnostics(request, window, cx);
                    })),
                ),
            );
        }
        if setup_phase.is_none() && !self.local_session_available() && self.new_session.is_none() {
            body = body.child(
                div()
                    .w_full()
                    .debug_selector(|| "home-local-guidance".into())
                    .text_style(TextStyle::Callout)
                    .text_color(bezel.text_muted)
                    .children(design::ink_probe(|| "home-local-guidance".into()))
                    .child("Connect to a local tmux server below. If none is running, start tmux in Terminal first."),
            );
        }
        body = body.child(div().w_full().child(self.new_session_controls(cx)));
        let mut detail = div()
            .debug_selector(|| "home-fleet-column".into())
            .min_w_0()
            .flex_1()
            .max_w(px(fleet::TABLE_MAX))
            .flex()
            .flex_col()
            .gap(px(SPACE * 1.5));
        let nav = self.fleet_nav(cx);
        if let Some(cards) = self.fleet_cards(window, cx) {
            // The left list names the view; the table needs no heading.
            detail = detail.child(cards);
        } else if is_live && !self.browser_state.sessions.is_empty() {
            let rows = self
                .browser_state
                .sessions
                .iter()
                .enumerate()
                .map(|(index, session)| {
                    let id = session.id.clone();
                    let (hover, muted) = (bezel.element_hover, bezel.text_muted);
                    let entered = self.home_entered(&session.id, now, reduced);
                    super::motion::enter(bezel.card_row(index == 0), entered)
                        .id(("tmux-home-session", index))
                        .debug_selector(move || format!("tmux-home-session-{index}"))
                        .py(px(6.))
                        .min_w_0()
                        .cursor_pointer()
                        .hover(move |s| s.bg(hover))
                        .child(
                            bezel_ui::icons::icon(bezel_ui::icons::Icon::asset(
                                "icons/terminal.svg",
                            ))
                            .size(px(bezel_ui::widgets::ICON_GLYPH))
                            .flex_none()
                            .text_color(muted),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .child(crate::sidebar::label_text(&session.label)),
                        )
                        .children(session.pane_count_label().map(|count| {
                            div()
                                .debug_selector(move || format!("tmux-home-count-{index}"))
                                .flex_none()
                                .text_style(TextStyle::Callout)
                                .text_color(muted)
                                .children(design::ink_probe(move || {
                                    format!("tmux-home-count-{index}")
                                }))
                                .child(count)
                        }))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            cx.stop_propagation();
                            this.home_select(request, &id, window, cx);
                        }))
                });
            detail = detail
                .child(div().text_style(TextStyle::Title3).child("Sessions"))
                .child(bezel.group_box().min_w_0().children(rows));
        } else if (!connected || setup_phase.is_none()) && !waiting && act.is_none() {
            let guidance = if !connected {
                bezel
                    .error_strip("Connection lost. Reopen tmux-ide to reconnect.")
                    .text_color(bezel.danger_muted)
                    .debug_selector(|| "home-guidance-error".into())
                    .children(design::ink_probe(|| "home-guidance-error".into()))
            } else if self.browser_state.home_phase == browser::HomePhase::Unavailable {
                bezel
                    .warning_strip("The daemon could not list sessions. Refresh to try again.")
                    .text_color(bezel.warning_muted)
                    .debug_selector(|| "home-guidance-warning".into())
                    .children(design::ink_probe(|| "home-guidance-warning".into()))
            } else {
                // Loading is the footer slot's (r5): this is only ever an empty list.
                let (title, hint) = (
                    "No live sessions",
                    "Start a new local session, or select a fleet server to create a session there.",
                );
                bezel
                    .empty_state(
                        bezel_ui::icons::Icon::asset("icons/terminal.svg"),
                        title,
                        hint,
                    )
                    .debug_selector(|| "home-empty".into())
            };
            detail = detail.child(guidance.w_full());
        }
        detail = detail.child(
            div()
                .debug_selector(|| "home-agents-column".into())
                .min_w_0()
                .w_full()
                .children(self.home_agent_status(cx)),
        );
        body = body.child(
            div()
                .mt(px(SPACE))
                .w_full()
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(SPACE * 2.))
                .children(nav)
                .child(detail),
        );
        let page = div()
            .id("tmux-home-page")
            .debug_selector(|| "tmux-home-page".into())
            .flex_1()
            .min_h_0()
            .w_full()
            .flex()
            .flex_col()
            .items_center()
            .child(body);
        let mut page = bezel_ui::scroll::Viewport::new("tmux-home-page", page, Axis::Vertical);
        if let Some(controls) = &self.home_filter {
            page = page.track_scroll(&controls.page_scroll);
        }
        div()
            .id("tmux-home")
            .debug_selector(|| "tmux-home".into())
            .track_focus(&self.terminal_focus)
            .flex_1()
            .min_w_0()
            .h_full()
            .flex()
            .flex_col()
            .bg(rgb(canvas))
            .child(page.fill())
            .into_any_element()
    }
}
#[cfg(test)]
#[path = "home/tests.rs"]
mod tests;

#[cfg(test)]
#[path = "home_keyboard_tests.rs"]
mod keyboard_tests;

#[path = "home/agents.rs"]
mod agents;
