//! The renderer probe's interface without the probe: every call is a no-op and
//! no frame ever carries a probe scope.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Scope {
    pub pane: String,
    pub generation: String,
    pub incarnation: String,
    pub request: u64,
    pub cols: u16,
    pub rows: u16,
    pub viewport_offset: u64,
}

pub(crate) mod runtime {
    use crate::tmux_snapshot::{browser, display_frame::DisplayFrame, keys::Input};

    pub(crate) fn enabled() -> bool {
        false
    }
    pub(crate) fn admit(input: Input, _: &browser::State) -> Input {
        input
    }
    pub(crate) fn tick() {}
    pub(crate) fn after_paint(_: &browser::State, _: &DisplayFrame, _: u16, _: u16, _: bool) {}
    pub(crate) fn rejected() {}
}
