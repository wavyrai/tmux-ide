//! Producer-owned immutable frames. Kernel send completion is not GPU retirement.
use crate::{surface_inbox::SendStatus, surface_port::SurfacePort, surface_sender::Sender};
use anyhow::{Context as _, Result, ensure};
use objc2_core_foundation::CFRetained;
use objc2_core_video::{CVPixelBuffer, CVPixelBufferGetIOSurface, kCVPixelFormatType_32BGRA};
use std::{collections::BTreeMap, sync::Mutex};

const MAX_BYTES: usize = 64 * 1024 * 1024;
const MAX_FRAMES: usize = 8;
const PROCESS_BYTES: usize = 256 * 1024 * 1024;
const PROCESS_FRAMES: usize = 32;
#[derive(Default)]
struct Counts {
    bytes: usize,
    frames: usize,
}
impl Counts {
    fn reserve(&mut self, bytes: usize) -> bool {
        if self.frames >= PROCESS_FRAMES || bytes > PROCESS_BYTES.saturating_sub(self.bytes) {
            return false;
        }
        self.bytes += bytes;
        self.frames += 1;
        true
    }
}
static RETAINED: Mutex<Counts> = Mutex::new(Counts {
    bytes: 0,
    frames: 0,
});
struct Charge(usize);
impl Charge {
    fn acquire(bytes: usize) -> Result<Self> {
        let mut counts = RETAINED
            .lock()
            .map_err(|_| anyhow::anyhow!("native producer accounting unavailable"))?;
        ensure!(
            counts.reserve(bytes),
            "native producer process budget exhausted"
        );
        Ok(Self(bytes))
    }
}
impl Drop for Charge {
    fn drop(&mut self) {
        if let Ok(mut counts) = RETAINED.lock() {
            counts.bytes -= self.0;
            counts.frames -= 1;
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Descriptor {
    pub sequence: u64,
    pub ticket: [u8; 16],
    pub width: usize,
    pub height: usize,
    pub stride: usize,
    pub allocation_bytes: usize,
}
struct Frame {
    buffer: CFRetained<CVPixelBuffer>,
    port: SurfacePort,
    descriptor: Descriptor,
    sent: bool,
    _charge: Charge,
}
/// One provider connection, bounded across all its panes. Stage only immutable
/// IOSurface-backed BGRA buffers; the producer must not retain a mutable alias.
/// Consumer-side budgets separately charge backing held by scene/GPU references.
#[derive(Default)]
pub struct Frames {
    frames: BTreeMap<u64, Frame>,
    bytes: usize,
    last_sequence: u64,
    stopped: bool,
}
impl Frames {
    /// Reserve and retain before publishing a control offer. Metadata comes from
    /// the actual backing, not caller-provided dimensions or global surface IDs.
    pub fn stage(
        &mut self,
        buffer: CFRetained<CVPixelBuffer>,
        ticket: [u8; 16],
        sequence: u64,
    ) -> Result<Descriptor> {
        ensure!(!self.stopped, "native producer frames are stopped");
        ensure!(
            sequence > self.last_sequence && sequence <= 9_007_199_254_740_991 && ticket != [0; 16],
            "invalid native producer frame identity"
        );
        let surface = CVPixelBufferGetIOSurface(Some(&buffer))
            .context("native producer requires IOSurface backing")?;
        let descriptor = Descriptor {
            sequence,
            ticket,
            width: surface.width(),
            height: surface.height(),
            stride: surface.bytes_per_row(),
            allocation_bytes: surface.alloc_size(),
        };
        ensure!(
            surface.plane_count() == 0
                && surface.pixel_format() == kCVPixelFormatType_32BGRA
                && descriptor.width > 0
                && descriptor.width <= 16384
                && descriptor.height > 0
                && descriptor.height <= 16384
                && descriptor.stride.is_multiple_of(4)
                && descriptor
                    .width
                    .checked_mul(4)
                    .is_some_and(|row| row <= descriptor.stride)
                && descriptor
                    .stride
                    .checked_mul(descriptor.height)
                    .is_some_and(|bytes| bytes <= descriptor.allocation_bytes)
                && descriptor.allocation_bytes <= MAX_BYTES,
            "invalid native producer backing"
        );
        ensure!(
            self.frames.len() < MAX_FRAMES
                && descriptor.allocation_bytes <= MAX_BYTES.saturating_sub(self.bytes),
            "native producer connection budget exhausted"
        );
        let charge = Charge::acquire(descriptor.allocation_bytes)?;
        let port = SurfacePort::from_surface(&surface)?;
        self.frames.insert(
            sequence,
            Frame {
                buffer,
                port,
                descriptor,
                sent: false,
                _charge: charge,
            },
        );
        self.bytes += descriptor.allocation_bytes;
        self.last_sequence = sequence;
        Ok(descriptor)
    }
    /// Send admitted offers in order. Backpressure keeps the same source buffer
    /// and ticket; no second reservation, copy or sequence is allocated on retry.
    pub fn try_send(&mut self, sender: &mut Sender, sequence: u64) -> Result<SendStatus> {
        ensure!(!self.stopped, "native producer frames are stopped");
        ensure!(
            self.frames
                .iter()
                .find(|(_, frame)| !frame.sent)
                .map(|(sequence, _)| *sequence)
                == Some(sequence),
            "native producer send is out of order"
        );
        let frame = self
            .frames
            .get_mut(&sequence)
            .context("native producer frame missing")?;
        let status = sender.try_send(&frame.port, frame.descriptor.ticket, sequence)?;
        if status == SendStatus::Queued {
            frame.sent = true;
        }
        Ok(status)
    }
    /// Cancel an offer that was never transferred. This does not expose backing
    /// for reuse and refuses to discard storage already owned by the receiver.
    pub fn discard_unsent(&mut self, sequence: u64) -> Result<()> {
        let frame = self.frames.get(&sequence).context("native producer frame missing")?;
        ensure!(!frame.sent, "cannot discard a transferred native frame");
        let bytes = frame.descriptor.allocation_bytes;
        self.frames.remove(&sequence);
        self.bytes -= bytes;
        Ok(())
    }
    /// Call only for a validated retirement from this original control socket.
    /// An unsent offer may also expire at the receiver, cancelling its queued send.
    /// Only this ACK path returns a buffer that the producer may recycle.
    pub fn retire(&mut self, sequence: u64) -> Result<CFRetained<CVPixelBuffer>> {
        let frame = self
            .frames
            .remove(&sequence)
            .context("native producer retirement is unknown or repeated")?;
        self.bytes -= frame.descriptor.allocation_bytes;
        Ok(frame.buffer)
    }
    /// Stop native sends. Unsent rights cannot be in a GPU; transferred storage
    /// remains retained until retirement, even though the transport has fallen back.
    pub fn fallback(&mut self) {
        self.stopped = true;
        self.frames.retain(|_, frame| frame.sent);
        self.bytes = self
            .frames
            .values()
            .map(|frame| frame.descriptor.allocation_bytes)
            .sum();
    }
    pub fn retained_bytes(&self) -> usize {
        self.bytes
    }
    pub fn outstanding(&self) -> usize {
        self.frames.len()
    }
    /// Disconnect discards producer references, never returns them for reuse.
    /// Receiver/GPU-owned native references independently keep backing alive.
    pub fn close(&mut self) {
        self.stopped = true;
        self.frames.clear();
        self.bytes = 0;
    }
}
#[cfg(test)]
#[path = "surface_frames_budget_tests.rs"]
mod tests;
