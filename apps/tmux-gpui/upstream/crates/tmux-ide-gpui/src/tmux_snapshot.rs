//! tmux-ide addition: an offline, read-only adapter qualification window.
//! This path never initializes Herdr discovery, settings, updates, or commands.
mod agent_indicator;
mod agent_spinner;
mod appearance;
mod browser;
mod browser_direct;
mod browser_native_actions;
mod browser_native_divider;
mod browser_native_editor;
mod browser_native_graphics;
mod browser_native_history;
mod browser_native_input;
mod browser_native_owner;
mod browser_native_preview;
#[cfg(target_os = "macos")]
mod browser_native_surfaces;
mod browser_native_transition;
mod browser_state;
mod browser_toolbar;
mod browser_ui;
mod composition;
mod controls;
mod copy;
mod decode;
pub(crate) mod design;
mod developer_mode;
mod diagnostics;
mod direct_projection;
mod display_frame;
mod divider;
mod geometry;
mod glass;
mod hit_regions;
mod home;
mod input_gate;
mod kbd;
mod keys;
mod kitty_graphics;
mod navigation;
mod new_session;
mod pane_actions;
mod pane_cards;
mod pane_chrome;
mod pane_shortcuts;
mod pending_input;
mod picker;
mod pointer;
mod presence;
mod renderer_probe;
mod selection;
mod session_history;
mod session_open;
mod session_tabs;
mod shell;
mod status_presentation;
mod stream;
mod terminal_font;
mod terminal_links;
#[cfg(test)]
mod tests;
mod workspace_chrome;
mod workspace_fleet_agents;

use crate::terminal_painter::{CellPixels, ImageTarget, PlacedImages, TerminalPainter};
use display_frame::DisplayFrame;
use gpui::{prelude::*, *};
use std::{cell::RefCell, ffi::OsString, path::PathBuf, rc::Rc, sync::Arc};

#[derive(Debug, thiserror::Error)]
pub(crate) enum Error {
    #[cfg(unix)]
    #[error("native fleet ownership failed")]
    NativeFleet(#[from] herdr_client::tmux_daemon::FleetRegistryError),
    #[error("native catalog worker failed")]
    NativeCatalog(#[from] herdr_client::tmux_daemon::WorkerError),
    #[error("native SSH owner shutdown failed")]
    NativeOwner(#[from] herdr_client::tmux_daemon::Error),
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
    let graphics = KittyView::default();
    graphics.placements.replace(kitty_graphics::load_static(
        &bytes,
        frame.width,
        frame.height,
        &graphics.store,
    )?);
    if valid_only {
        println!("Validated tmux snapshot: {}x{}", frame.width, frame.height);
        return Ok(());
    }
    show(Some(frame.into()), None, None, graphics)
}

pub(crate) fn welcome() -> Result<(), Error> {
    show(None, None, None, KittyView::default())
}

pub(crate) fn live() -> Result<(), Error> {
    show(None, Some(stream::start()), None, KittyView::default())
}

pub(crate) fn browse() -> Result<(), Error> {
    let graphics = KittyView::default();
    let bridge = browser::start(graphics.store.clone());
    show(None, None, Some(bridge), graphics)
}

pub(crate) fn browse_native_local() -> Result<(), Error> {
    let record = herdr_client::tmux_daemon::LocalConfigNamespace::capture(None)
        .and_then(|namespace| namespace.daemon_record())
        .ok_or(Error::Invalid("invalid local runtime namespace"))?;
    browse_native(record)
}

pub(crate) fn browse_native(record: PathBuf) -> Result<(), Error> {
    if !record.is_absolute() {
        return Err(Error::Invalid(
            "native daemon record must be an absolute path",
        ));
    }
    let graphics = KittyView::default();
    let (bridge, owner) = browser::start_local(record, graphics.store.clone())?;
    let result = show_owned(None, None, Some(bridge), graphics, Some(owner.clone()));
    let cleanup = owner.shutdown();
    result?;
    cleanup
}

#[cfg(unix)]
pub(crate) fn browse_native_remote(
    target: &std::ffi::OsStr,
    environment: Option<&std::ffi::OsStr>,
    local_record: Option<PathBuf>,
) -> Result<(), Error> {
    if local_record
        .as_ref()
        .is_some_and(|path| !path.is_absolute())
    {
        return Err(Error::Invalid(
            "local daemon record must be an absolute path",
        ));
    }
    let target = target
        .to_str()
        .ok_or(Error::Invalid("invalid SSH destination"))?;
    let target = herdr_client::tmux_ssh::SshTarget::parse(target)
        .map_err(|_| Error::Invalid("invalid SSH destination"))?;
    let environment = environment
        .map(|value| {
            let value = value
                .to_str()
                .ok_or(Error::Invalid("invalid remote environment identity"))?;
            if value.len() != 36 || uuid::Uuid::parse_str(value).is_err() {
                return Err(Error::Invalid("invalid remote environment identity"));
            }
            Ok(value.to_owned())
        })
        .transpose()?;
    let graphics = KittyView::default();
    let (bridge, owner) =
        browser::start_remote(target, environment, local_record, graphics.store.clone())?;
    let result = show_owned(None, None, Some(bridge), graphics, Some(owner.clone()));
    let cleanup = owner.shutdown();
    result?;
    cleanup
}

pub(crate) fn browse_with_helper(
    node: &std::ffi::OsStr,
    script: &std::ffi::OsStr,
    host: &std::ffi::OsStr,
) -> Result<(), Error> {
    // Paths are supplied by the version-pinned app launcher, never terminal data.
    // Spawn before entering GPUI; the owner retires/reaps only this child off-thread.
    let herdr_client::tmux_broker_process::Broker {
        reader,
        writer,
        owner,
    } = herdr_client::tmux_broker_process::spawn(node, script, host)?;
    let graphics = KittyView::default();
    let bridge = browser::start_io(
        graphics.store.clone(),
        move || std::io::BufReader::new(reader),
        move || writer,
        true,
    );
    let result = show(None, None, Some(bridge), graphics);
    let retired = owner.shutdown();
    result.and(retired.map_err(Error::from))
}

fn show(
    frame: Option<DisplayFrame>,
    mailbox: Option<stream::Mailbox>,
    browser: Option<browser::Bridge>,
    graphics: KittyView,
) -> Result<(), Error> {
    show_owned(frame, mailbox, browser, graphics, None)
}
fn show_owned(
    frame: Option<DisplayFrame>,
    mailbox: Option<stream::Mailbox>,
    browser: Option<browser::Bridge>,
    graphics: KittyView,
    owner: Option<browser::NativeOwner>,
) -> Result<(), Error> {
    let failed = Rc::new(std::cell::Cell::new(false));
    let open_failed = failed.clone();
    let application = gpui_platform::application().with_assets(crate::icons::Icons);
    application.run(move |cx| {
        let closing = Rc::new(std::cell::Cell::new(false));
        let quit_owner = owner.clone();
        let quit_closing = closing.clone();
        cx.on_window_closed(move |cx, _| {
            if cx.windows().is_empty() {
                request_native_quit(quit_owner.clone(), quit_closing.clone(), cx);
            }
        })
        .detach();
        cx.bind_keys([KeyBinding::new("cmd-q", crate::Quit, None)]);
        shell::bind_keys(cx);
        let action_owner = owner.clone();
        let action_closing = closing.clone();
        cx.on_action(move |_: &crate::Quit, cx| {
            request_native_quit(action_owner.clone(), action_closing.clone(), cx);
        });
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
                let snapshot = cx.new(|cx: &mut Context<SnapshotView>| {
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
                                            view.frame = update.map(DisplayFrame::from);
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
                                        view.flush_pending_input(cx);
                                        renderer_probe::runtime::tick();
                                        if !view.terminal_input_ready()
                                            || view.selection.is_some()
                                            || view.divider.is_some()
                                        {
                                            view.fit_settle.clear();
                                        } else if view.fit_settle.due(std::time::Instant::now()) {
                                            cx.notify();
                                        }
                                        view.flush_attention();
                                        view.flush_palette(cx);
                                        view.flush_kitty_graphics(cx);
                                        view.tick_agent_indicators(cx);
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
                                            view.finish_header_actions(window, cx);
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
                            view.cancel_pending_input(cx);
                            view.sidebar_keyboard.active = false;
                            view.cancel_session_open();
                            view.header_controls = Default::default();
                            view.cancel_attention();
                            view.cancel_palette();
                            if view.attention_picker_open() {
                                view.picker = None;
                            }
                        }
                        view.divider = None;
                        view.pane_actions = None;
                        view.presence.set_active(window.is_window_active());
                        view.clear_selection(cx);
                        view.last_resize = None;
                        view.fit_settle.clear();
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
                        graphics: graphics.clone(),
                        presence: presence::Presence::new(window.is_window_active()),
                        _activation: Some(activation),
                        _appearance: Some(appearance),
                        last_system: None,
                        glass: Default::default(),
                        last_workspace_session: None,
                        pending_session_open: None,
                        header_controls: Default::default(),
                        painter: Rc::new(RefCell::new(TerminalPainter::default())),
                        _task: task,
                        _browser_task: browser_task,
                        browsing: browser.is_some(),
                        terminal_focus: cx.focus_handle(),
                        input_interrupted: false,
                        pending_input: None,
                        picker: None,
                        attention: Default::default(),
                        palette: Default::default(),
                        session_history: Default::default(),
                        session_tabs: Default::default(),
                        workspace_fleet_agents: Default::default(),
                        home_filter: None,
                        pane_actions: None,
                        browser_address: None,
                        new_session: None,
                        new_session_queued: None,
                        agent_animation: Default::default(),
                        sidebar_hidden: false,
                        sidebar_keyboard: Default::default(),
                        developer_mode: Default::default(),
                        terminal_font: Default::default(),
                        window_reveal: Default::default(),
                        resize_gesture: Default::default(),
                        last_resize: None,
                        fit_settle: Default::default(),
                        marked: String::new(),
                        marked_selection: None,
                        input_geometry: None,
                        input_cell_width: None,
                        painted_focus: None,
                        painted_frame: None,
                        pointer: Default::default(),
                        selection: None,
                        divider: None,
                        wheel: crate::terminal::WheelRemainder::default(),
                        browser_request: 0,
                        browser_state: home::initial_state(),
                        browser_commands: browser.map(|b| b.commands),
                    };
                    view.discover_terminal_fonts(cx);
                    view.load_developer_mode(cx);
                    view.follow_system(cx);
                    view
                });
                agent_spinner::window_root(snapshot, window, cx)
            },
        );
        if let Err(error) = result {
            eprintln!("Could not open snapshot window: {error}");
            open_failed.set(true);
            request_native_quit(owner.clone(), closing.clone(), cx);
        } else {
            cx.activate(true);
        }
    });
    if failed.get() {
        return Err(Error::Invalid("native window could not open"));
    }
    Ok(())
}

/// Rounded width/height followed by precise width/height in thousandths of a pixel.
type CellPixelDimensions = (u32, u32, u32, u32);

/// Kitty graphics owned by one window: the image store (shared with the
/// publication reader) and, for static snapshots, their fixed placements.
#[derive(Clone, Default)]
struct KittyView {
    store: kitty_graphics::Store,
    placements: Rc<RefCell<Vec<kitty_graphics::Placement>>>,
    /// Cell size in device pixels last reported with a resize.
    cell_pixels: Rc<std::cell::Cell<Option<CellPixelDimensions>>>,
}

struct SnapshotView {
    frame: Option<DisplayFrame>,
    /// Kitty graphics images and the static snapshot's placements.
    graphics: KittyView,
    browsing: bool,
    presence: presence::Presence,
    _activation: Option<Subscription>,
    _appearance: Option<Subscription>,
    last_system: Option<appearance::System>,
    glass: glass::Glass,
    last_workspace_session: Option<String>,
    pending_session_open: Option<session_open::Intent>,
    header_controls: pane_chrome::Controls,
    terminal_focus: FocusHandle,
    input_interrupted: bool,
    pending_input: Option<pending_input::Pending>,
    picker: Option<picker::Picker>,
    attention: picker::attention::Owner,
    palette: picker::palette::Owner,
    session_history: session_history::Owner,
    session_tabs: session_tabs::Owner,
    workspace_fleet_agents: workspace_fleet_agents::Owner,
    home_filter: Option<home::filters::Controls>,
    pane_actions: Option<pane_actions::Menu>,
    browser_address: Option<browser_toolbar::Address>,
    new_session: Option<new_session::Dialog>,
    new_session_queued: Option<(u64, u64)>,
    agent_animation: agent_spinner::Slots,
    sidebar_hidden: bool,
    sidebar_keyboard: browser_ui::SidebarKeyboard,
    developer_mode: developer_mode::Settings,
    terminal_font: terminal_font::Settings,
    window_reveal: workspace_chrome::WindowReveal,
    resize_gesture: divider::Owner,
    last_resize: Option<(u64, u16, u16)>,
    fit_settle: geometry::FitSettle,
    marked: String,
    marked_selection: Option<std::ops::Range<usize>>,
    input_cell_width: Option<f32>,
    painted_focus: Option<pending_input::PaintedFocus>,
    painted_frame: Option<DisplayFrame>,
    pointer: pointer::Owner,
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
impl SnapshotView {
    /// Repaint when an image completes; ask the bridge for absent images.
    fn flush_kitty_graphics(&mut self, cx: &mut Context<Self>) {
        if self.graphics.store.take_changed() {
            cx.notify();
        }
        let missing = self.graphics.store.take_missing();
        if !missing.is_empty()
            && let Some(sender) = &self.browser_commands
        {
            let _ = sender.try_send(browser::Command::KittyMissing { digests: missing });
        }
    }
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
        self.prepare_terminal_font();
        let font = self.terminal_font.config.font();
        let height = self.terminal_height();
        let font_revision = self.terminal_font.revision;
        let width = self.painter.borrow_mut().cell_width(&font, window, cx);
        let painter = self.painter.clone();
        let separator = controls::separator(&theme);
        let highlights = self
            .selection
            .as_ref()
            .map_or_else(Vec::new, |selection| selection.highlights.clone());
        let entity = cx.entity();
        // Browse publications carry placements per frame; static files once.
        let kitty_scene = if self.browsing {
            self.graphics.store.scene(&self.browser_state.graphics)
        } else {
            self.graphics
                .store
                .scene(&self.graphics.placements.borrow())
        };
        let kitty_store = self.graphics.store.clone();
        let kitty_cell_pixels = self.graphics.cell_pixels.clone();
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
        #[cfg(target_os = "macos")]
        let native_surfaces = self
            .browser_state
            .native_surfaces
            .as_ref()
            .filter(|(source, surfaces)| source.same(&frame) && surfaces.len() <= 8)
            .map(|(_, surfaces)| surfaces.clone())
            .unwrap_or_default();
        let resize_preview = self.divider_content_preview();
        let cards = self.card_layout(width);
        let painted_gutters = (cards.is_some()
            && resize_preview.is_none()
            && hit_regions::is_painted(Some(&frame), self.browser_state.frame.as_ref()))
        .then(|| divider::paint::Painted::capture(&self.browser_state, width, height))
        .flatten();
        div()
            .relative()
            .size_full()
            // Cards own their opaque surfaces; gutters expose the shell material.
            .when(cards.is_none(), |terminal| {
                terminal.bg(rgb(theme.background))
            })
            .overflow_hidden()
            .children(self.card_surfaces(width))
            .child(
                canvas(
                    |_, _, _| (),
                    move |bounds, (), window, cx| {
                        if entity.read(cx).terminal_font.revision != font_revision {
                            return;
                        }
                        entity.update(cx, |view, cx| {
                            if view.browsing
                                // Platform text delivery is not input authority. Keep it
                                // installed across focus loss so the first returning commit
                                // reaches the bounded admission gate before the next repaint.
                                && ((view.presence.ready() && view.browser_state.input_ready)
                                    || view.pending_input_ready()
                                    || view.browser_state.native_focus_target.is_some())
                                && !view.browser_state.retained_preview
                                && view.selection.is_none()
                                && view.divider.is_none()
                                && !view.resize_gesture.busy()
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
                            let cursor = frame.view().cursor();
                            let origin = bounds.origin
                                + point(
                                    px(width * cursor.map_or(0., |c| f32::from(c.x))),
                                    px(height * cursor.map_or(0., |c| f32::from(c.y))),
                                );
                            let origin = cards.as_ref().map_or(origin, |layout| {
                                bounds.origin
                                    + layout.cursor(
                                        cursor.map_or(0, |c| c.x),
                                        cursor.map_or(0, |c| c.y),
                                    )
                            });
                            let cursor_bounds = Bounds::new(origin, size(px(width), px(height)));
                            view.input_geometry = Some((bounds, cursor_bounds));
                            view.input_cell_width = Some(width);
                            // A translated preview is not evidence that canonical
                            // hit coordinates are on screen, including after cancel.
                            view.painted_frame = resize_preview.is_none().then(|| frame.clone());
                            view.resize_gesture
                                .record_painted_gutters(painted_gutters.clone());
                            view.record_painted_focus();
                            if let Some((cols, rows)) = geometry::cell_grid(
                                f32::from(
                                    bounds.size.width
                                        - cards.as_ref().map_or(px(0.), |l| l.overhead().width),
                                ),
                                f32::from(
                                    bounds.size.height
                                        - cards.as_ref().map_or(px(0.), |l| l.overhead().height),
                                ),
                                width,
                                height,
                            ) {
                                let desired = (view.browser_request, cols, rows);
                                let scale = window.scale_factor();
                                let cell_pixels = (
                                    (width * scale).round().max(1.) as u32,
                                    (height * scale).round().max(1.) as u32,
                                    (width * scale * 1000.).round().clamp(1000., 1024000.) as u32,
                                    (height * scale * 1000.).round().clamp(1000., 1024000.) as u32,
                                );
                                let pixels_changed =
                                    view.graphics.cell_pixels.get() != Some(cell_pixels);
                                if view.browsing
                                    && view.presence.ready()
                                    && view.browser_state.input_ready
                                    && !view.browser_state.retained_preview
                                    && view.selection.is_none()
                                    && view.divider.is_none()
                                    && view.picker.is_none()
                                    && view.pane_actions.is_none()
                                    && view.new_session.is_none()
                                    && view.fit_settle.ready(
                                        geometry::Fit {
                                            request: desired.0,
                                            cols,
                                            rows,
                                            pixels: cell_pixels,
                                        },
                                        view.last_resize,
                                        pixels_changed,
                                        std::time::Instant::now(),
                                    )
                                    && let (Some(sender), Some(id)) =
                                        (&view.browser_commands, &view.browser_state.selected_pane)
                                {
                                    let command = browser::Command::Input {
                                        input_target: None,
                                        request: view.browser_request,
                                        id: id.clone(),
                                        input: keys::Input::Resize {
                                            cols,
                                            rows,
                                            cell_width: Some(cell_pixels.0),
                                            cell_height: Some(cell_pixels.1),
                                            cell_width_milli: Some(cell_pixels.2),
                                            cell_height_milli: Some(cell_pixels.3),
                                        },
                                    };
                                    if sender.try_send(command).is_ok() {
                                        view.capture_viewport_input(cols, rows);
                                        view.last_resize = Some(desired);
                                        view.fit_settle.clear();
                                        view.graphics.cell_pixels.set(Some(cell_pixels));
                                    }
                                }
                            } else {
                                view.fit_settle.clear();
                            }
                        });
                        if let Some(preview) = &resize_preview
                            && cards.is_none()
                        {
                            kitty_store.with_images(|images| {
                                preview.paint(
                                    &mut painter.borrow_mut(),
                                    frame.view(),
                                    bounds,
                                    width,
                                    height,
                                    &font,
                                    separator,
                                    (!kitty_scene.is_empty()).then_some(PlacedImages {
                                        placements: &kitty_scene,
                                        images,
                                        target: ImageTarget::Main,
                                        cell_pixels: kitty_cell_pixels.get().map(
                                            |(width, height, _, _)| CellPixels {
                                                width,
                                                height,
                                                scale: window.scale_factor(),
                                            },
                                        ),
                                    }),
                                    window,
                                    cx,
                                );
                            });
                            return;
                        }
                        let rails = entity.update(cx, |view, _| {
                            if !hit_regions::is_painted(
                                Some(&frame),
                                view.browser_state.frame.as_ref(),
                            ) {
                                return Vec::new();
                            }
                            let mut cells: Vec<_> = view
                                .browser_state
                                .regions
                                .iter()
                                .flat_map(|pane| {
                                    hit_regions::separator_cells(
                                        &pane.id,
                                        &view.browser_state.regions,
                                        &frame,
                                        &view.browser_state.panes,
                                    )
                                })
                                .collect();
                            // Shared edges paint once, independent of which pane is selected.
                            cells.sort_unstable_by_key(|cell| (cell.col, cell.row, cell.vertical));
                            cells.dedup();
                            cells
                        });
                        let paint_ok = kitty_store.with_images(|images| {
                            if let Some(layout) = &cards {
                                let target =
                                    resize_preview.as_ref().map(|p| layout.reflow(&p.regions));
                                return target.as_ref().unwrap_or(layout).paint(
                                    &layout.regions,
                                    &mut painter.borrow_mut(),
                                    frame.view(),
                                    bounds,
                                    &font,
                                    &highlights,
                                    (!kitty_scene.is_empty()).then_some(PlacedImages {
                                        placements: &kitty_scene,
                                        images,
                                        target: ImageTarget::Main,
                                        cell_pixels: kitty_cell_pixels.get().map(
                                            |(width, height, _, _)| CellPixels {
                                                width,
                                                height,
                                                scale: window.scale_factor(),
                                            },
                                        ),
                                    }),
                                    window,
                                    cx,
                                );
                            }
                            painter.borrow_mut().paint_view(
                                frame.view(),
                                bounds.origin,
                                Some(bounds.size),
                                width,
                                &font,
                                &highlights,
                                &[],
                                None,
                                (!kitty_scene.is_empty()).then_some(PlacedImages {
                                    placements: &kitty_scene,
                                    images,
                                    target: ImageTarget::Main,
                                    cell_pixels: kitty_cell_pixels.get().map(
                                        |(width, height, _, _)| CellPixels {
                                            width,
                                            height,
                                            scale: window.scale_factor(),
                                        },
                                    ),
                                }),
                                window,
                                cx,
                            )
                        });
                        #[cfg(target_os = "macos")]
                        if paint_ok {
                            for surface in &native_surfaces {
                                if let Some(layout) = &cards {
                                    for r in &layout.regions {
                                        let mut clip = layout.content(r);
                                        clip.origin += bounds.origin;
                                        let translated = Bounds::new(
                                            bounds.origin + layout.translation(r),
                                            bounds.size,
                                        );
                                        window.with_content_mask(
                                            Some(ContentMask {
                                                bounds: clip.intersect(&bounds),
                                                ..Default::default()
                                            }),
                                            |window| {
                                                surface.paint(translated, width, height, window)
                                            },
                                        );
                                    }
                                } else {
                                    surface.paint(bounds, width, height, window);
                                }
                            }
                        }
                        entity.update(cx, |view, _| {
                            if view.selection.is_none()
                                && view.picker.is_none()
                                && view.pane_actions.is_none()
                                && view.new_session.is_none()
                                && view.divider.is_none()
                            {
                                renderer_probe::runtime::after_paint(
                                    &view.browser_state,
                                    &frame,
                                    (f32::from(
                                        bounds.size.width
                                            - cards.as_ref().map_or(px(0.), |l| l.overhead().width),
                                    ) / width)
                                        .floor()
                                        .max(0.) as u16,
                                    (f32::from(
                                        bounds.size.height
                                            - cards
                                                .as_ref()
                                                .map_or(px(0.), |l| l.overhead().height),
                                    ) / height)
                                        .floor()
                                        .max(0.) as u16,
                                    paint_ok,
                                );
                            }
                        });
                        window.with_content_mask(
                            Some(ContentMask {
                                bounds,
                                ..Default::default()
                            }),
                            |window| {
                                for cell in rails.iter().filter(|_| cards.is_none()) {
                                    let (x, y, w, h) = if cell.vertical {
                                        (
                                            f32::from(cell.col) * width,
                                            f32::from(cell.row) * height,
                                            width,
                                            height,
                                        )
                                    } else {
                                        (
                                            f32::from(cell.col) * width,
                                            (f32::from(cell.row) + 0.5) * height
                                                - height.min(1.) / 2.,
                                            width,
                                            height.min(1.),
                                        )
                                    };
                                    window.paint_quad(fill(
                                        Bounds::new(
                                            bounds.origin + point(px(x), px(y)),
                                            size(px(w), px(h)),
                                        ),
                                        separator,
                                    ));
                                }
                            },
                        );
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
            .children(self.pane_header_labels(width, cx))
            .children(self.divider_handles(width))
            .children(self.lower_pane_header_controls(width, cx))
            .into_any_element()
    }
}

#[cfg(test)]
mod fit_test_support;

#[cfg(feature = "integration-test")]
pub(crate) mod journey_probe;

// Normal Quit/last-window-close waits off-thread before asking macOS to exit.
// GPUI's final shutdown hook has only 200 ms, less than SSH's TERM grace period.
fn request_native_quit(
    owner: Option<browser::NativeOwner>,
    closing: Rc<std::cell::Cell<bool>>,
    cx: &mut App,
) {
    let Some(owner) = owner else {
        cx.quit();
        return;
    };
    if closing.replace(true) {
        return;
    }
    let cleanup = cx
        .background_executor()
        .spawn(async move { owner.shutdown() });
    cx.spawn(async move |cx| match cleanup.await {
        Ok(()) => {
            cx.update(|cx| cx.quit());
        }
        Err(error) => {
            eprintln!("tmux-ide: native SSH shutdown failed: {error}");
            closing.set(false);
        }
    })
    .detach();
}
