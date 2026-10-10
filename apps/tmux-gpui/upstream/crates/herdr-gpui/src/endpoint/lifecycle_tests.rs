//! Exercise GUI lifecycle transitions through real, isolated client transports.
#![allow(clippy::unwrap_used)]
use super::*;
use crate::controls::Command;
use gpui::{
    AppContext, ClipboardItem, Image, ImageFormat, MouseButton, MouseDownEvent, MouseMoveEvent,
    MouseUpEvent, point, px, size,
};
use herdr_client::{
    ClientEvent, Method, SavedHost,
    protocol::{endpoint::*, *},
};
use std::{
    os::unix::net::{UnixListener, UnixStream},
    path::PathBuf,
    sync::atomic::AtomicU64,
};

mod close_pane;
mod dead_keys;
mod endpoint_switch;
mod focus_fences;
mod horizontal_wheel;
mod image_paste;
mod image_paste_native;
mod input_gap;
mod keyboard;
mod mouse_gestures;
mod mouse_targets;
mod prompts;
mod reconnect_backoff;
mod remote_drop;
mod sounds;
mod split_drag;
mod toast_handoff;
mod toast_navigation;
mod window_notices;
mod workspace_menu_navigation;

struct Server {
    stream: UnixStream,
    path: PathBuf,
}

// Keep the tested entity out of the render tree: a terminal canvas would enqueue
// unrelated native resize requests while these tests advance the lifecycle.
struct Fixture(gpui::Entity<HerdrWindow>);
impl gpui::Render for Fixture {
    fn render(&mut self, _: &mut gpui::Window, _: &mut Context<Self>) -> impl gpui::IntoElement {
        gpui::div()
    }
}

impl Server {
    /// The next lifecycle frame. Every connection reports the window's theme
    /// once it has a snapshot; `window::tests` covers that, so skip it here.
    fn receive(&mut self) -> ClientMessage {
        loop {
            match read_message(&mut self.stream, MAX_FRAME_SIZE).unwrap() {
                ClientMessage::ClientShellHostTheme { .. } => {}
                message => return message,
            }
        }
    }

    fn respond(&mut self, request: &serde_json::Value) {
        let id = request["id"].as_str().unwrap();
        write_message(
            &mut self.stream,
            &ServerMessage::ClientShellEndpointResponseChunk {
                boot_id: snapshot().boot_id,
                request_id: id.into(),
                final_chunk: true,
                data: serde_json::to_vec(&serde_json::json!({"id": id, "result": {}})).unwrap(),
            },
            MAX_GRAPHICS_FRAME_SIZE,
        )
        .unwrap();
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn snapshot() -> ClientShellSnapshot {
    serde_json::from_str(include_str!(
        "../../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"
    ))
    .unwrap()
}

fn surface(snapshot: &ClientShellSnapshot) -> Arc<PaneSurfaceFrame> {
    Arc::new(PaneSurfaceFrame {
        boot_id: snapshot.boot_id.clone(),
        projection_revision: snapshot.revision,
        surface_revision: 1,
        frame: FrameData {
            width: 80,
            height: 24,
            cells: vec![],
            cursor: None,
            hyperlinks: vec![],
            graphics: vec![],
        },
        panes: vec![],
        splits: vec![],
        popup: None,
        graphics: Default::default(),
    })
}

/// Poll until the inbox has been projected into `live`, then return.
///
/// `ConnectionBridge::take_update` reads the inbox under `try_lock` so the UI
/// thread never blocks on the socket worker: a poll that races the worker
/// projects nothing and the next one delivers it. A test that polls once and
/// asserts is therefore reading whatever `live` happened to hold, which is a
/// revision behind whenever the worker held the lock. Drive polls until the
/// expected state lands instead of assuming a single poll suffices.
fn project_until(
    view: &mut HerdrWindow,
    cx: &mut Context<HerdrWindow>,
    what: &str,
    ready: impl Fn(&HerdrWindow) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        view.poll_endpoints(cx);
        if ready(view) {
            return;
        }
        assert!(Instant::now() < deadline, "{what} was never projected");
        std::thread::sleep(Duration::from_millis(1));
    }
}

fn wait_until(mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while !ready() {
        assert!(
            Instant::now() < deadline,
            "client worker did not finish in time"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
}

fn connected_endpoint(id: &str) -> (Endpoint, Server) {
    static SERIAL: AtomicU64 = AtomicU64::new(0);
    let path = std::env::temp_dir().join(format!(
        "hg-{}-{}.sock",
        std::process::id(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    ));
    let listener = UnixListener::bind(&path).unwrap();
    listener.set_nonblocking(true).unwrap();
    let mut endpoint = Endpoint::new(
        id.into(),
        id.into(),
        ConnectTarget::Socket(path.clone()),
        true,
    );
    endpoint.connect(ConnectOptions::default(), true);
    let mut accepted = None;
    wait_until(|| {
        accepted = listener.accept().ok();
        accepted.is_some()
    });
    let mut server = Server {
        stream: accepted.unwrap().0,
        path,
    };
    server.stream.set_nonblocking(false).unwrap();
    server
        .stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    server
        .stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    assert!(matches!(
        server.receive(),
        ClientMessage::EndpointControl { .. }
    ));
    let mut welcome: EndpointServerWelcome = serde_json::from_str(include_str!(
        "../../../herdr-protocol/tests/fixtures/endpoint-welcome-v1.json"
    ))
    .unwrap();
    welcome.capabilities.extend([
        "surface_interest".into(),
        "presentation_effects_fence".into(),
    ]);
    welcome.methods.extend(
        [
            Method::ClientShellSurfaceSet,
            Method::WorkspaceCreate,
            Method::TabCreate,
            Method::PaneSplit,
            Method::LayoutSetSplitRatio,
            Method::TabFocus,
            Method::PaneFocus,
            Method::WorkspaceFocus,
            Method::PaneFocusDirection,
            Method::PaneZoom,
            Method::PaneResize,
            Method::PaneSwap,
            Method::PaneClear,
            Method::PaneClose,
            Method::TabClose,
            Method::CommandInvoke,
            Method::WorkspaceClose,
            Method::WorktreeCreate,
            Method::WorktreeOpen,
            Method::WorktreeRemove,
        ]
        .map(|method| method.as_str().to_owned()),
    );
    for (kind, data) in [
        (
            ENDPOINT_WELCOME_KIND,
            serde_json::to_string(&welcome).unwrap(),
        ),
        (
            ENDPOINT_SNAPSHOT_KIND,
            serde_json::to_string(&snapshot()).unwrap(),
        ),
    ] {
        write_message(
            &mut server.stream,
            &ServerMessage::EndpointControl {
                kind: kind.into(),
                data,
            },
            MAX_GRAPHICS_FRAME_SIZE,
        )
        .unwrap();
    }
    wait_until(|| {
        endpoint.poll(Instant::now());
        endpoint.connection.handle.is_some() && endpoint.live.snapshot.is_some()
    });
    assert!(endpoint.live.supports_surface);
    let frame = surface(endpoint.live.snapshot.as_ref().unwrap());
    endpoint
        .connection
        .inbox
        .lock()
        .unwrap()
        .apply(ClientEvent::Surface(frame));
    endpoint.poll(Instant::now());
    (endpoint, server)
}

fn prepare_mouse(view: &mut HerdrWindow, endpoint: Endpoint, cx: &mut Context<HerdrWindow>) {
    view.endpoints.truncate(1);
    view.endpoints.push(endpoint);
    view.selected_endpoint = 1;
    view.options = ConnectOptions::default();
    view.reset_selected(cx);
    view.activation_deadline = None;
    let snapshot = Arc::make_mut(view.live.snapshot.as_mut().unwrap());
    let mut inactive = snapshot.panes[0].clone();
    inactive.pane_id = "w1:p2".into();
    inactive.focused = false;
    snapshot.panes.push(inactive);
    Arc::make_mut(view.live.surface.as_mut().unwrap()).panes = [0, 40]
        .into_iter()
        .map(|x| PaneSurfacePane {
            pane_id: if x == 0 { "w1:p1" } else { "w1:p2" }.into(),
            content_revision: 1,
            rect: SurfaceRect {
                x,
                y: 0,
                width: 40,
                height: 24,
            },
            inner_rect: SurfaceRect {
                x: x + 1,
                y: 1,
                width: 38,
                height: 22,
            },
            scrollbar_rect: None,
            scroll: None,
            focused: x == 0,
            mouse_reporting: true,
            sgr_pixel_mouse: false,
            alternate_screen_active: false,
            pixel_width: 760,
            pixel_height: 880,
        })
        .collect();
    view.cell_width = 10.;
    view.bounds = gpui::Bounds::new(
        point(px(100.), px(50.)),
        size(px(800.), px(24. * view.config.terminal.line_height())),
    );
    assert!(view.input_ready());
}

fn mouse_position(view: &HerdrWindow, column: f32, row: f32) -> gpui::Point<gpui::Pixels> {
    view.bounds.origin
        + point(
            px(column * 10.),
            px(row * view.config.terminal.line_height()),
        )
}

fn mouse_event(kind: ClientMouseKind, column: u16, row: u16) -> ClientPaneInputEvent {
    ClientPaneInputEvent::Mouse {
        kind,
        position: ClientMousePosition::Cell { column, row },
        geometry: None,
        modifiers: 0,
        lines: 1,
    }
}

fn clipboard_image(bytes: &[u8]) -> ClipboardItem {
    ClipboardItem::new_image(&Image::from_bytes(ImageFormat::Png, bytes.to_vec()))
}

fn prepare_remote_image(
    view: &mut HerdrWindow,
    mut endpoint: Endpoint,
    cx: &mut Context<HerdrWindow>,
) {
    // Only change the classification after connecting the isolated socket harness.
    endpoint.connection.target = ConnectTarget::Ssh {
        target: "unused-image-test.invalid".into(),
        session: "default".into(),
    };
    prepare_mouse(view, endpoint, cx);
    assert!(view.accepts_remote_images());
}

fn image_popup(view: &mut HerdrWindow, id: &str) {
    let surface = Arc::make_mut(view.live.surface.as_mut().unwrap());
    surface.popup = Some(Box::new(ClientShellPopupSurface {
        terminal_id: id.into(),
        title: String::new(),
        width: None,
        height: None,
        frame: surface.frame.clone(),
        mouse_reporting: false,
        sgr_pixel_mouse: false,
        pixel_width: 800,
        pixel_height: 480,
    }));
}

fn wait_image_finished(view: &gpui::Entity<HerdrWindow>, cx: &mut gpui::VisualTestContext) {
    // GPUI tasks publish the frame; only the socket worker can finish its FIFO slot.
    wait_until(|| {
        view.update(cx, |view, _| {
            view.cancel_stale_image();
            view.pending_images.is_empty()
        })
    });
}
