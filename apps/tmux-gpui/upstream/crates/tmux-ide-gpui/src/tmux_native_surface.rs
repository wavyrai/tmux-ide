//! Native surface boundary for the authenticated transport integration. Import on
//! its worker, then project against current topology and paint prepared buffers.
//! This API does not authenticate peers or advertise provider availability.
use gpui::{Bounds, ContentMask, Pixels, Window, point, px, size};
use gpui_apple::surface_port::SurfacePort;
use herdr_client::{
    tmux_graphics::surface_offer::{Accepted, Placement},
    tmux_native_session::CommittedPane,
    tmux_topology::{PresentedWindow, WindowPaint},
};
use objc2_core_foundation::CFRetained;
use objc2_core_video::CVPixelBuffer;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

#[path = "tmux_native_surface_connection.rs"]
pub mod connection;
#[path = "tmux_native_surface_driver.rs"]
pub mod driver;
#[path = "tmux_native_surface_producer.rs"]
pub mod producer;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("native surface pane changed before import")]
    Identity,
    #[error("native surface storage import failed")]
    Import(#[source] anyhow::Error),
}
// CVBuffer is generally mutable, so the bindings deliberately do not mark it
// Send. This private wrapper is constructed only after import and owner attachment.
// It exposes no buffer/attachment mutation or CPU pixel pointers; clones only
// retain, and the only consuming API is GPUI's UI-thread surface painter.
#[derive(Clone)]
struct PreparedBuffer(CFRetained<CVPixelBuffer>);
// SAFETY: this locally created CoreVideo wrapper is immutable after construction.
// CF retain/release and immutable queries may cross threads; scene/GPU ownership
// retains the same buffer. No Sync implementation or mutable API is exposed.
// https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/Multithreading/ThreadSafetySummary/ThreadSafetySummary.html
#[allow(unsafe_code)] // Narrow immutable CoreFoundation transfer boundary above.
unsafe impl Send for PreparedBuffer {}

/// Imported storage keeps the admission lease attached to CoreVideo. A scene's
/// final CPU reference is not necessarily its final Metal/GPU reference.
pub struct Image {
    accepted: Accepted,
    buffer: PreparedBuffer,
    live: Arc<AtomicBool>,
    publication: Arc<AtomicBool>,
}
impl Image {
    pub(crate) fn same_surface(&self, other: &Self) -> bool {
        self.accepted.pane() == other.accepted.pane()
            && self.accepted.surface_id() == other.accepted.surface_id()
    }
    pub(crate) fn current(&self, window: &PresentedWindow) -> bool {
        self.live.load(Ordering::Acquire)
            && self.publication.load(Ordering::Acquire)
            && window
                .paint
                .regions
                .iter()
                .any(|region| self.accepted.is_current(&region.pane, &region.source))
    }
    /// `port` must already be authenticated and joined to this offer's one-use
    /// ticket by the connection owner. This additional check fences async import.
    pub fn import(
        accepted: Accepted,
        port: SurfacePort,
        pane: &str,
        current: &CommittedPane,
    ) -> Result<Self, Error> {
        if !accepted.is_current(pane, current) {
            return Err(Error::Identity);
        }
        let layout = accepted.layout();
        let buffer = port
            .import(
                layout.width,
                layout.height,
                layout.stride,
                layout.allocation_bytes,
                accepted.storage_lease(),
            )
            .map_err(Error::Import)?;
        Ok(Self {
            accepted,
            buffer: PreparedBuffer(buffer),
            live: Arc::new(AtomicBool::new(true)),
            publication: Arc::new(AtomicBool::new(true)),
        })
    }
    /// A new projection is required after topology/history changes. Incoherent
    /// previews and a selected pane's history never paint current native pixels.
    pub fn project(&self, window: &PresentedWindow, history_offset: usize) -> Option<Paint> {
        if !window.coherent
            || !self.live.load(Ordering::Acquire)
            || !self.publication.load(Ordering::Acquire)
        {
            return None;
        }
        window.paint.regions.iter().find_map(|region| {
            if history_offset > 0 && region.pane == window.paint.selected_pane {
                return None;
            }
            let placement = self.accepted.in_region(region)?;
            Some(Paint {
                buffer: self.buffer.clone(),
                window: Arc::clone(&window.paint),
                placement,
                live: Arc::clone(&self.live),
                publication: Arc::clone(&self.publication),
            })
        })
    }
}
#[derive(Clone)]
pub struct Paint {
    buffer: PreparedBuffer,
    window: Arc<WindowPaint>,
    placement: Placement,
    live: Arc<AtomicBool>,
    publication: Arc<AtomicBool>,
}
impl Paint {
    pub fn source(&self) -> &Arc<WindowPaint> {
        &self.window
    }
    pub fn placement(&self) -> Placement {
        self.placement
    }
    /// Only call during paint with the same displayed frame used for projection.
    /// The application additionally binds this batch to its DisplayFrame identity.
    pub fn paint(
        &self,
        viewport: Bounds<Pixels>,
        cell_width: f32,
        line_height: f32,
        window: &mut Window,
    ) {
        if !self.live.load(Ordering::Acquire)
            || !self.publication.load(Ordering::Acquire)
            || !cell_width.is_finite()
            || !line_height.is_finite()
            || cell_width <= 0.
            || line_height <= 0.
        {
            return;
        }
        let p = self.placement;
        let bounds = Bounds::new(
            viewport.origin
                + point(
                    px(p.column as f32 * cell_width),
                    px(p.row as f32 * line_height),
                ),
            size(
                px(p.columns as f32 * cell_width),
                px(p.rows as f32 * line_height),
            ),
        );
        window.with_content_mask(
            Some(ContentMask {
                bounds: viewport,
                ..Default::default()
            }),
            |window| window.paint_surface(bounds, self.buffer.0.clone()),
        );
    }
}

#[cfg(test)]
#[path = "tmux_native_surface_tests.rs"]
pub(crate) mod tests;
