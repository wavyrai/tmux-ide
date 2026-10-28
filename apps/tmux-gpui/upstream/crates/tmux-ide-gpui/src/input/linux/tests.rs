#![allow(clippy::unwrap_used)]

use super::WeakInputHandler;
use crate::{
    input::TerminalInputHandler, search_input::SearchInput, sidebar::layout_tests::fixture_window,
};
use gpui::{
    AppContext, Bounds, ClipboardItem, InputHandler, TestAppContext, TextInputConfiguration, point,
    px, size,
};

mod lifecycle;
