//! Immutable displayed state, independent of its legacy or native storage.
use crate::terminal_painter::{FrameView, NativeFrame};
use herdr_client::protocol::FrameData;
use std::sync::Arc;

#[derive(Clone, Debug)]
pub(super) enum DisplayFrame {
    Legacy(Arc<FrameData>),
    Native(Arc<NativeFrame>),
}
impl DisplayFrame {
    #[cfg(test)]
    pub fn legacy(&self) -> &Arc<FrameData> {
        match self {
            Self::Legacy(frame) => frame,
            Self::Native(_) => panic!("test expected legacy fixture"),
        }
    }
    #[cfg(test)]
    pub fn legacy_mut(&mut self) -> &mut Arc<FrameData> {
        match self {
            Self::Legacy(frame) => frame,
            Self::Native(_) => panic!("test expected legacy fixture"),
        }
    }
    pub fn view(&self) -> FrameView<'_> {
        match self {
            Self::Legacy(frame) => frame.as_ref().into(),
            Self::Native(frame) => frame.as_ref().into(),
        }
    }
    /// The exact retained presentation, not merely equal geometry or cell contents.
    pub fn same(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Legacy(a), Self::Legacy(b)) => Arc::ptr_eq(a, b),
            (Self::Native(a), Self::Native(b)) => Arc::ptr_eq(a, b),
            _ => false,
        }
    }
}
impl From<Arc<FrameData>> for DisplayFrame {
    fn from(frame: Arc<FrameData>) -> Self {
        Self::Legacy(frame)
    }
}
impl From<Arc<NativeFrame>> for DisplayFrame {
    fn from(frame: Arc<NativeFrame>) -> Self {
        Self::Native(frame)
    }
}

impl<'a> From<&'a DisplayFrame> for FrameView<'a> {
    fn from(frame: &'a DisplayFrame) -> Self {
        frame.view()
    }
}

#[cfg(test)]
#[path = "display_frame_tests.rs"]
mod tests;
