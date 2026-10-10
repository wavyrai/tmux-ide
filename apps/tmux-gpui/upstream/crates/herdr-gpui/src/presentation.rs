//! Which frame the terminal area paints, across the gap between projections.
//!
//! The daemon projects one surface per client, for the focused pane tree alone,
//! so changing space costs a round trip: the client drops its surface when it
//! fences the focus change, and the replacement arrives milliseconds later. The
//! same gap opens whenever a snapshot revision lands before the surface of that
//! revision. Painting nothing in those gaps flashes the empty background between
//! two pictures; a multiplexer redrawing a cell grid never blanks between them.
//! Keeping the last presented frame on screen until its replacement is ready
//! removes the flash without pretending the old frame is current state.
//!
//! A lost connection keeps its last frame too, once the window asks it to
//! with [`Presentation::hold`]: the endpoint reconnects in place, and the
//! picture stays up, dimmed as stale, until the replacement connection
//! presents its own frame or reports another boot.
//!
//! Retained cells are presentation only. Hit testing, input routing, and IME
//! placement keep reading `LiveState::surface`, so a retained frame can never
//! aim a click or a keystroke at a pane the client has already left.

use crate::state::LiveState;
use herdr_client::{SurfaceImages, protocol::PaneSurfaceFrame};
use std::sync::Arc;

/// A frame with the pixels for the images it places.
#[derive(Clone)]
pub(crate) struct Picture {
    pub(crate) frame: Arc<PaneSurfaceFrame>,
    pub(crate) images: Arc<SurfaceImages>,
}

#[derive(Default)]
pub(crate) struct Presentation {
    presented: Option<Arc<PaneSurfaceFrame>>,
    /// The pixels the presented frame was shown with. A retained frame keeps
    /// them, since the connection's own set follows the newest surface.
    images: Arc<SurfaceImages>,
    /// The presented frame belongs to a connection that was lost, and stays
    /// up only to show where the reconnecting endpoint left off.
    stale: bool,
    /// The endpoint is down, so any surface `live` still holds, or that the
    /// lost connection delivered late, is the lost connection's too.
    held: bool,
    #[cfg(feature = "integration-test")]
    pub(crate) probe: Probe,
}

impl Presentation {
    /// The frame to paint now, recorded as what the window shows: the ready
    /// surface when the client has one, and otherwise the frame last presented
    /// for as long as it can still stand for this window's content.
    pub(crate) fn frame(&mut self, live: &LiveState) -> Option<Arc<PaneSurfaceFrame>> {
        match live.surface.clone().filter(|_| live.surface_ready()) {
            Some(ready) => {
                self.presented = Some(ready);
                self.images = live.surface_images.clone();
                // Only a frame accepted after `resume` is the new connection's.
                self.stale = self.held;
            }
            None if self.stale && !self.rebooted(live) => {}
            None if !self.retainable(live) => self.clear(),
            None => {
                #[cfg(feature = "integration-test")]
                {
                    self.probe.retained += 1;
                }
            }
        }
        #[cfg(feature = "integration-test")]
        if self.presented.is_none() {
            self.probe.blank += 1;
        }
        self.presented.clone()
    }

    /// A frame from another boot, or from a connection that is no longer up,
    /// stands for nothing this window can still claim to be showing.
    fn retainable(&self, live: &LiveState) -> bool {
        let Some(presented) = &self.presented else {
            return false;
        };
        live.status.is_connected()
            && live
                .snapshot
                .as_ref()
                .is_some_and(|snapshot| snapshot.boot_id == presented.boot_id)
    }

    /// A daemon that restarted while the connection was down no longer has
    /// the terminals the stale frame shows.
    fn rebooted(&self, live: &LiveState) -> bool {
        self.presented
            .as_ref()
            .zip(live.snapshot.as_ref())
            .is_some_and(|(presented, snapshot)| presented.boot_id != snapshot.boot_id)
    }

    /// Keep the presented frame, as stale, across a lost connection until the
    /// endpoint's next connection presents a frame of its own.
    pub(crate) fn hold(&mut self) {
        self.held = true;
        self.stale |= self.presented.is_some();
    }

    /// The endpoint has a connection again: its next ready frame is current.
    /// The stale picture stays up, dimmed, until that frame arrives.
    pub(crate) fn resume(&mut self) {
        self.held = false;
    }

    /// Whether the frame on screen is a lost connection's, painted dimmed.
    pub(crate) fn stale(&self) -> bool {
        self.stale
    }

    /// Forget the picture. Another connection's window is not this one's, so a
    /// detach, a retarget, or a switch of endpoint starts from an empty area.
    pub(crate) fn clear(&mut self) {
        self.presented = None;
        self.images = Default::default();
        self.stale = false;
        self.held = false;
    }

    /// The frame to paint now, as `frame` chooses it, with its images.
    pub(crate) fn picture(&mut self, live: &LiveState) -> Option<Picture> {
        let frame = self.frame(live)?;
        Some(Picture {
            frame,
            images: self.images.clone(),
        })
    }
}

/// Paint outcomes the native smoke driver reads to prove a space switch never
/// blanks the terminal area.
#[cfg(feature = "integration-test")]
#[derive(Clone, Copy, Debug, Default)]
pub struct Probe {
    /// Renders that painted no frame at all: an empty terminal area.
    pub blank: u64,
    /// Renders that repainted the presented frame while the next was in flight.
    pub retained: u64,
}

#[cfg(test)]
mod tests;
