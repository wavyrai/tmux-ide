//! tmux-ide addition: an offline, read-only adapter qualification window.
//! This path never initializes Herdr discovery, settings, updates, or commands.
mod appearance;
mod browser;
mod browser_state;
mod browser_ui;
mod composition;
mod copy;
mod decode;
mod divider;
mod geometry;
mod glass;
mod hit_regions;
mod home;
mod input_gate;
mod keys;
mod navigation;
mod new_session;
mod pane_actions;
mod pane_chrome;
mod picker;
mod presence;
mod selection;
mod session_open;
mod shell;
mod stream;
#[cfg(test)]
mod tests;
mod workspace_chrome;

use crate::terminal_painter::TerminalPainter;
use gpui::{prelude::*, *};
use herdr_client::protocol::FrameData;
use std::{cell::RefCell, ffi::OsString, path::PathBuf, rc::Rc, sync::Arc};

#[derive(Debug, thiserror::Error)]
pub(crate) enum Error {
    #[error("usage: --tmux-snapshot FILE [--validate-only]")]
    Arguments,
    #[error("cannot read snapshot: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid snapshot JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("snapshot exceeds the 8 MiB limit")]
    TooLarge,
    #[error("invalid snapshot: {0}")]
    Invalid(&'static str),
}

pub(crate) fn run(args: Vec<OsString>) -> Result<(), Error> {
    let valid_only = args.len() == 2 && args[1] == "--validate-only";
    if args.is_empty() || (args.len() != 1 && !valid_only) {
        return Err(Error::Arguments);
    }
    // Bounded file read happens before starting GPUI, never on its UI thread.
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(PathBuf::from(&args[0]))?
        .take(8 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err(Error::TooLarge);
    }
    let frame = Arc::new(decode::frame(&bytes)?);
    if valid_only {
        println!("Validated tmux snapshot: {}x{}", frame.width, frame.height);
        return Ok(());
    }
    show(Some(frame), None, None)
}

pub(crate) fn welcome() -> Result<(), Error> {
    show(None, None, None)
}

pub(crate) fn live() -> Result<(), Error> {
    show(None, Some(stream::start()), None)
}

pub(crate) fn browse() -> Result<(), Error> {
    show(None, None, Some(browser::start()))
}

fn show(
    frame: Option<Arc<FrameData>>,
    mailbox: Option<stream::Mailbox>,
    browser: Option<browser::Bridge>,
) -> Result<(), Error> {
    let failed = Rc::new(std::cell::Cell::new(false));
    let open_failed = failed.clone();
    gpui_platform::application().run(move |cx| {
        cx.on_window_closed(|cx, _| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
        cx.bind_keys([KeyBinding::new("cmd-q", crate::Quit, None)]);
        cx.on_action(|_: &crate::Quit, cx| cx.quit());
        let bounds = Bounds::centered(None, size(px(1000.), px(650.)), cx);
        let result = cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                app_id: Some("com.tmux-ide.snapshot-preview".into()),
                ..if browser.is_some() {
                    shell::options()
                } else {
                    WindowOptions {
                        titlebar: Some(TitlebarOptions {
                            title: Some("tmux-ide — read-only preview".into()),
                            ..Default::default()
                        }),
                        ..Default::default()
                    }
                }
            },
            |window, cx| {
                cx.new(|cx: &mut Context<SnapshotView>| {
                    let task = mailbox.map(|mailbox| {
                        cx.spawn(async move |entity, cx| {
                            loop {
                                cx.background_executor()
                                    .timer(std::time::Duration::from_millis(16))
                                    .await;
                                let update =
                                    mailbox.try_lock().ok().and_then(|mut slot| slot.take());
                                if let Some(update) = update
                                    && entity
                                        .update(cx, |view, cx| {
                                            if update.is_none() {
                                                eprintln!("tmux-preview: unavailable applied");
                                            }
                                            view.frame = update;
                                            view.refresh_picker(cx);
                                            view.refresh_pane_actions(cx);
                                            view.refresh_new_session(cx);
                                            cx.notify();
                                        })
                                        .is_err()
                                {
                                    break;
                                }
                            }
                        })
                    });
                    let browser_task = browser.as_ref().map(|bridge| {
                        let mailbox = bridge.mailbox.clone();
                        cx.spawn_in(window, async move |entity, cx| {
                            loop {
                                cx.background_executor()
                                    .timer(std::time::Duration::from_millis(16))
                                    .await;
                                if entity
                                    .update(cx, |view, cx| {
                                        if let Some(sender) = &view.browser_commands {
                                            view.presence.flush(sender);
                                        }
                                        view.flush_resize_gesture(cx);
                                        if view.glass.take_policy_change() {
                                            cx.notify();
                                        }
                                    })
                                    .is_err()
                                {
                                    break;
                                }
                                let update =
                                    mailbox.try_lock().ok().and_then(|mut slot| slot.take());
                                if let Some(state) = update {
                                    let done = state.is_none();
                                    if entity
                                        .update_in(cx, |view, window, cx| {
                                            view.apply_browser_state(state, cx);
                                            view.finish_session_open(window, cx);
                                        })
                                        .is_err()
                                        || done
                                    {
                                        break;
                                    }
                                }
                            }
                        })
                    });
                    let activation = cx.observe_window_activation(window, |view, window, cx| {
                        if !window.is_window_active() {
                            view.pending_session_open = None;
                        }
                        view.divider = None;
                        view.pane_actions = None;
                        view.presence.set_active(window.is_window_active());
                        view.clear_selection(cx);
                        view.last_resize = None;
                        view.wheel = Default::default();
                        view.discard_composition(cx);
                        if let Some(sender) = &view.browser_commands {
                            view.presence.flush(sender);
                        }
                        cx.notify();
                    });
                    let appearance = cx.observe_window_appearance(window, |view, _, cx| {
                        view.follow_system(cx);
                    });
                    let mut view = SnapshotView {
                        frame,
                        presence: presence::Presence::new(window.is_window_active()),
                        _activation: Some(activation),
                        _appearance: Some(appearance),
                        last_system: None,
                        glass: Default::default(),
                        last_workspace_session: None,
                        pending_session_open: None,
                        painter: Rc::new(RefCell::new(TerminalPainter::default())),
                        _task: task,
                        _browser_task: browser_task,
                        browsing: browser.is_some(),
                        terminal_focus: cx.focus_handle(),
                        input_interrupted: false,
                        picker: None,
                        pane_actions: None,
                        new_session: None,
                        new_session_queued: None,
                        window_reveal: Default::default(),
                        resize_gesture: Default::default(),
                        last_resize: None,
                        marked: String::new(),
                        marked_selection: None,
                        input_geometry: None,
                        input_cell_width: None,
                        painted_frame: None,
                        selection: None,
                        divider: None,
                        wheel: crate::terminal::WheelRemainder::default(),
                        browser_request: 0,
                        browser_state: home::initial_state(),
                        browser_commands: browser.map(|b| b.commands),
                    };
                    view.follow_system(cx);
                    view
                })
            },
        );
        if let Err(error) = result {
            eprintln!("Could not open snapshot window: {error}");
            open_failed.set(true);
            cx.quit();
        } else {
            cx.activate(true);
        }
    });
    if failed.get() {
        return Err(Error::Invalid("native window could not open"));
    }
    Ok(())
}

struct SnapshotView {
    frame: Option<Arc<FrameData>>,
    browsing: bool,
    presence: presence::Presence,
    _activation: Option<Subscription>,
    _appearance: Option<Subscription>,
    last_system: Option<appearance::System>,
    glass: glass::Glass,
    last_workspace_session: Option<String>,
    pending_session_open: Option<(u64, String)>,
    terminal_focus: FocusHandle,
    input_interrupted: bool,
    picker: Option<picker::Picker>,
    pane_actions: Option<pane_actions::Menu>,
    new_session: Option<new_session::Dialog>,
    new_session_queued: Option<(u64, u64)>,
    window_reveal: workspace_chrome::WindowReveal,
    resize_gesture: divider::Owner,
    last_resize: Option<(u64, u16, u16)>,
    marked: String,
    marked_selection: Option<std::ops::Range<usize>>,
    input_cell_width: Option<f32>,
    painted_frame: Option<Arc<FrameData>>,
    selection: Option<selection::Capture>,
    divider: Option<divider::Drag>,
    wheel: crate::terminal::WheelRemainder,
    input_geometry: Option<(Bounds<Pixels>, Bounds<Pixels>)>,
    browser_request: u64,
    browser_state: browser::State,
    browser_commands: Option<std::sync::mpsc::SyncSender<browser::Command>>,
    _browser_task: Option<Task<()>>,
    _task: Option<Task<()>>,
    painter: Rc<RefCell<TerminalPainter>>,
}
impl Render for SnapshotView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.browsing {
            return self.browser_render(window, cx);
        }
        self.terminal_render(window, cx)
    }
}
impl SnapshotView {
    fn terminal_render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme();
        self.painter.borrow_mut().set_appearance(
            crate::terminal::FONT_SIZE,
            crate::terminal::CELL_HEIGHT,
            theme.clone(),
        );
        let font = font("Menlo");
        let width = self.painter.borrow_mut().cell_width(&font, window, cx);
        let painter = self.painter.clone();
        let accent = self.accent();
        let highlights = self
            .selection
            .as_ref()
            .map_or_else(Vec::new, |selection| selection.highlights.clone());
        let entity = cx.entity();
        let Some(frame) = self.frame.clone() else {
            let guidance = if self.browsing && self.browser_commands.is_some() {
                "Select a session and pane. If the connection is unavailable, refresh sessions to reconnect."
            } else {
                "Waiting for a verified pane, or connection unavailable. Restart the preview to reconnect."
            };
            return div()
                .size_full()
                .bg(rgb(theme.background))
                .text_color(rgb(theme.foreground))
                .p_4()
                .child(guidance)
                .into_any_element();
        };
        div()
            .relative()
            .size_full()
            .bg(rgb(theme.background))
            .overflow_hidden()
            .child(
                canvas(
                    |_, _, _| (),
                    move |bounds, (), window, cx| {
                        entity.update(cx, |view, cx| {
                            if view.browsing
                                && view.presence.ready()
                                && view.browser_state.input_ready
                                && view.selection.is_none()
                                && view.divider.is_none()
                                && view.picker.is_none()
                                && view.pane_actions.is_none()
                                && view.new_session.is_none()
                            {
                                window.handle_input(
                                    &view.terminal_focus,
                                    crate::input::ViewInputHandler::new(bounds, cx.entity()),
                                    cx,
                                );
                            }
                            let cursor = frame.cursor.as_ref();
                            let origin = bounds.origin
                                + point(
                                    px(width * cursor.map_or(0., |c| f32::from(c.x))),
                                    px(crate::terminal::CELL_HEIGHT
                                        * cursor.map_or(0., |c| f32::from(c.y))),
                                );
                            let cursor_bounds = Bounds::new(
                                origin,
                                size(px(width), px(crate::terminal::CELL_HEIGHT)),
                            );
                            view.input_geometry = Some((bounds, cursor_bounds));
                            view.input_cell_width = Some(width);
                            view.painted_frame = Some(frame.clone());
                            if let Some((cols, rows)) = geometry::cell_grid(
                                f32::from(bounds.size.width),
                                f32::from(bounds.size.height),
                                width,
                                crate::terminal::CELL_HEIGHT,
                            ) {
                                let desired = (view.browser_request, cols, rows);
                                if view.browsing
                                    && view.presence.ready()
                                    && view.browser_state.input_ready
                                    && view.selection.is_none()
                                    && view.divider.is_none()
                                    && view.picker.is_none()
                                    && view.pane_actions.is_none()
                                    && view.new_session.is_none()
                                    && view.last_resize != Some(desired)
                                    && let (Some(sender), Some(id)) =
                                        (&view.browser_commands, &view.browser_state.selected_pane)
                                {
                                    let command = browser::Command::Input {
                                        request: view.browser_request,
                                        id: id.clone(),
                                        input: keys::Input::Resize { cols, rows },
                                    };
                                    if sender.try_send(command).is_ok() {
                                        view.last_resize = Some(desired);
                                    }
                                }
                            }
                        });
                        let rails = entity.update(cx, |view, _| {
                            if !hit_regions::is_painted(
                                Some(&frame),
                                view.browser_state.frame.as_ref(),
                            ) {
                                return Vec::new();
                            }
                            view.browser_state.selected_pane.as_deref().map_or_else(
                                Vec::new,
                                |selected| {
                                    hit_regions::separator_cells(
                                        selected,
                                        &view.browser_state.regions,
                                        &frame,
                                        &view.browser_state.panes,
                                    )
                                },
                            )
                        });
                        painter.borrow_mut().paint_frame(
                            &frame,
                            bounds.origin,
                            Some(bounds.size),
                            width,
                            &font,
                            &highlights,
                            &[],
                            None,
                            None,
                            window,
                            cx,
                        );
                        window.with_content_mask(Some(ContentMask { bounds }), |window| {
                            for cell in &rails {
                                let height = crate::terminal::CELL_HEIGHT;
                                let (x, y, w, h) = if cell.vertical {
                                    (
                                        (f32::from(cell.col) + 0.5) * width - width.min(2.) / 2.,
                                        f32::from(cell.row) * height,
                                        width.min(2.),
                                        height,
                                    )
                                } else {
                                    (
                                        f32::from(cell.col) * width,
                                        (f32::from(cell.row) + 0.5) * height - height.min(2.) / 2.,
                                        width,
                                        height.min(2.),
                                    )
                                };
                                window.paint_quad(fill(
                                    Bounds::new(
                                        bounds.origin + point(px(x), px(y)),
                                        size(px(w), px(h)),
                                    ),
                                    rgb(accent),
                                ));
                            }
                        });
                        entity.update(cx, |view, _| {
                            if let Some((grid, cursor)) = view.input_geometry {
                                painter.borrow().paint_composition(
                                    &view.marked,
                                    cursor.origin,
                                    grid,
                                    &font,
                                    window,
                                );
                            }
                        });
                    },
                )
                .size_full(),
            )
            .children(self.lower_pane_headers(width))
            .children(self.divider_handles(width))
            .into_any_element()
    }
}
