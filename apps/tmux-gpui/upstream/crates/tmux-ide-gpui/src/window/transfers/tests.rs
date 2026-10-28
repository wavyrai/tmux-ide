#![allow(clippy::unwrap_used)]

use super::{FileTransfer, HerdrWindow, transfer_progress};
use crate::{connection::ConnectionBridge, terminal::InputTarget};
use crate::{sidebar::layout_tests::fixture_window, state::ConnectionStatus};
use gpui::{
    AppContext, Bounds, Context, Entity, IntoElement, Modifiers, MouseButton, Render,
    TestAppContext, VisualTestContext, Window, div, point, prelude::*, px, size,
};
use herdr_client::{
    Client, ClientEvent, ConnectOptions, ConnectTarget, Stream, connect_with_connector,
    protocol::{endpoint::*, *},
};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

mod cancellation;
mod completion;
mod progress;

const HOST: &str = "upload-test.invalid";
const REMOTE: &str = "/tmp/herdr-upload.ABCDEF123456/it's a file";

// Render only the actual transfer card, over real terminal mouse handlers.
// Keeping the terminal canvas out avoids unrelated resize/paint commands.
struct Fixture {
    view: Option<Entity<HerdrWindow>>,
    fallthrough: usize,
}

impl Render for Fixture {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let overlay = self
            .view
            .as_ref()
            .and_then(|view| view.update(cx, |view, cx| view.render_file_transfer(window, cx)));
        div()
            .size_full()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, event, window, cx| {
                    this.fallthrough += 1;
                    if let Some(view) = &this.view {
                        view.update(cx, |view, cx| {
                            view.terminal_mouse_down(event, window, cx);
                        });
                    }
                }),
            )
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, event, _, cx| {
                    this.fallthrough += 1;
                    if let Some(view) = &this.view {
                        view.update(cx, |view, cx| view.terminal_mouse_up(event, cx));
                    }
                }),
            )
            .children(overlay)
    }
}

fn fixture(window: &mut Window, cx: &mut Context<Fixture>) -> Fixture {
    Fixture {
        view: Some(cx.new(|cx| fixture_window(window, cx))),
        fallthrough: 0,
    }
}

/// A daemon peer that has sent its welcome and snapshot fixtures.
pub(crate) struct Peer {
    pub(crate) client: Client,
    stream: Stream,
}

impl Peer {
    pub(crate) fn new() -> Self {
        Self::advertising(&[])
    }

    /// A peer whose welcome also advertises `methods`, so requests the
    /// fixture's welcome lacks reach the wire instead of being refused.
    pub(crate) fn advertising(methods: &[&str]) -> Self {
        let mut welcome: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../herdr-protocol/tests/fixtures/endpoint-welcome-v1.json"
        ))
        .unwrap();
        if let Some(advertised) = welcome["methods"].as_array_mut() {
            advertised.extend(methods.iter().map(|method| serde_json::json!(method)));
        }
        let welcome = welcome.to_string();
        let (stream, mut server) = Stream::pair().unwrap();
        server
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        server
            .set_write_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let client = connect_with_connector(
            ConnectTarget::Local,
            ConnectOptions::default(),
            true,
            move |_, _| Ok(stream),
        )
        .unwrap();
        assert!(matches!(
            read_message(&mut server, MAX_FRAME_SIZE).unwrap(),
            ClientMessage::EndpointControl { .. }
        ));
        for (kind, data) in [
            (ENDPOINT_WELCOME_KIND, welcome.as_str()),
            (
                ENDPOINT_SNAPSHOT_KIND,
                include_str!("../../../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"),
            ),
        ] {
            write_message(
                &mut server,
                &ServerMessage::EndpointControl {
                    kind: kind.into(),
                    data: data.into(),
                },
                MAX_FRAME_SIZE,
            )
            .unwrap();
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match client
                .events
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap()
            {
                ClientEvent::Snapshot(_) => break,
                ClientEvent::Disconnected { reason, .. } => {
                    panic!("mock peer disconnected: {reason}")
                }
                _ => {}
            }
        }
        Self {
            client,
            stream: server,
        }
    }

    pub(crate) fn receive(&mut self) -> ClientMessage {
        read_message(&mut self.stream, MAX_FRAME_SIZE).unwrap()
    }

    /// The next endpoint API request, skipping the resize and focus
    /// traffic a drawn window sends on its own.
    pub(crate) fn request(&mut self) -> serde_json::Value {
        loop {
            if let ClientMessage::ClientShellEndpointRequest { request, .. } = self.receive() {
                return serde_json::from_str(&request).unwrap();
            }
        }
    }

    /// Answers `request_id` with `response`, an endpoint envelope, and
    /// returns the event the client reports for it, skipping events that
    /// arrived before it.
    pub(crate) fn respond(
        &mut self,
        boot_id: &str,
        request_id: &str,
        response: &serde_json::Value,
    ) -> ClientEvent {
        write_message(
            &mut self.stream,
            &ServerMessage::ClientShellEndpointResponseChunk {
                boot_id: boot_id.into(),
                request_id: request_id.into(),
                final_chunk: true,
                data: serde_json::to_vec(response).unwrap(),
            },
            MAX_FRAME_SIZE,
        )
        .unwrap();
        loop {
            let event = self
                .client
                .events
                .recv_timeout(Duration::from_secs(3))
                .unwrap();
            if matches!(&event, ClientEvent::Response { request_id: id, .. } if id == request_id) {
                return event;
            }
        }
    }

    pub(crate) fn prepare(&self, view: &mut HerdrWindow, cx: &mut Context<HerdrWindow>) {
        // Only the fixture's explicit nonexistent local socket is used to
        // initialize endpoint lifecycle flags. Replace its handle before
        // marking the synthetic projection as SSH; never reconnect to HOST.
        view.reconnect(cx);
        // Retire that attempt as Endpoint::stop does: its connector and event
        // reader keep the old inbox, so their late failure cannot hold or
        // overwrite the one tests drive, as a plain disconnect would allow.
        view.endpoints[0].connection.detach(false);
        view.endpoints[0].connection.handle = Some(self.client.handle.clone());
        view.endpoints[0].connection.target = ConnectTarget::Ssh {
            target: HOST.into(),
            session: "default".into(),
        };
        let snapshot: ClientShellSnapshot = serde_json::from_str(include_str!(
            "../../../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"
        ))
        .unwrap();
        view.live.snapshot = Some(Arc::new(snapshot.clone()));
        view.live.status = ConnectionStatus::Connected;
        view.live.surface = Some(Arc::new(PaneSurfaceFrame {
            boot_id: snapshot.boot_id,
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
            panes: vec![PaneSurfacePane {
                pane_id: "w1:p1".into(),
                content_revision: 1,
                rect: SurfaceRect {
                    x: 0,
                    y: 0,
                    width: 80,
                    height: 24,
                },
                inner_rect: SurfaceRect {
                    x: 0,
                    y: 0,
                    width: 80,
                    height: 24,
                },
                scrollbar_rect: None,
                scroll: None,
                focused: true,
                mouse_reporting: true,
                sgr_pixel_mouse: false,
                alternate_screen_active: false,
                pixel_width: 800,
                pixel_height: 480,
            }],
            splits: vec![],
            popup: None,
            graphics: Default::default(),
        }));
        view.options = ConnectOptions::default();
        view.cell_width = 10.;
        view.bounds = Bounds::new(point(px(0.), px(0.)), size(px(800.), px(480.)));
        assert!(view.accepts_remote_images());
    }

    fn sentinel(&mut self, view: &Entity<HerdrWindow>, cx: &mut VisualTestContext) {
        view.read_with(cx, |view, _| {
            ConnectionBridge::send_input(
                &self.client.handle,
                &view.live.snapshot.as_ref().unwrap().boot_id,
                &InputTarget::Pane("w1:p1".into()),
                ClientPaneInputEvent::TextCommit("sentinel".into()),
            )
            .unwrap();
        });
        assert_eq!(
            self.receive(),
            ClientMessage::ClientShellPaneInput {
                pane_id: "w1:p1".into(),
                events: vec![ClientPaneInputEvent::TextCommit("sentinel".into())],
            }
        );
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        self.client.handle.disconnect();
    }
}

fn popup(view: &mut HerdrWindow, id: &str) {
    let surface = Arc::make_mut(view.live.surface.as_mut().unwrap());
    surface.popup = Some(Box::new(ClientShellPopupSurface {
        terminal_id: id.into(),
        title: String::new(),
        width: None,
        height: None,
        frame: surface.frame.clone(),
        mouse_reporting: true,
        sgr_pixel_mouse: false,
        pixel_width: 800,
        pixel_height: 480,
    }));
}

fn pending(view: &HerdrWindow, target: InputTarget) -> FileTransfer {
    FileTransfer {
        endpoint: view.endpoints[0].id.clone(),
        host: HOST.into(),
        epoch: view.selection_epoch,
        generation: view.endpoints[0].generation,
        boot: view.live.snapshot.as_ref().unwrap().boot_id.clone(),
        target,
        label: "large file".into(),
        cancelled: Arc::new(AtomicBool::new(false)),
        sent: Arc::new(AtomicU64::new(0)),
        total: Arc::new(AtomicU64::new(0)),
        shown: (0, 0, false),
    }
}
