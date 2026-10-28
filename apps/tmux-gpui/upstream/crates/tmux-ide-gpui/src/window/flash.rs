//! The brief message over the terminal: "copied to clipboard", or why a
//! shortcut did nothing. It answers the user's own gesture, so it needs no
//! dismissing and retires on its own. Any window code can raise one with
//! [`HerdrWindow::show_flash`]; nothing here names individual messages.

use super::HerdrWindow;
use crate::config::Theme;
use gpui::{Context, SharedString};
use std::time::{Duration, Instant};

/// How long a flash stays up, matching herdr's own clipboard feedback.
const FLASH_DURATION: Duration = Duration::from_secs(2);

/// Whether the flash reports something done or something declined.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Tone {
    Success,
    Warning,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Flash {
    pub(crate) tone: Tone,
    pub(crate) text: SharedString,
}

impl Flash {
    pub(crate) fn success(text: impl Into<SharedString>) -> Self {
        Self {
            tone: Tone::Success,
            text: text.into(),
        }
    }

    pub(crate) fn warning(text: impl Into<SharedString>) -> Self {
        Self {
            tone: Tone::Warning,
            text: text.into(),
        }
    }

    /// Green for something done, yellow for something declined.
    pub(crate) fn accent(&self, theme: &Theme) -> u32 {
        theme.ink(match self.tone {
            Tone::Success => theme.palette[2],
            Tone::Warning => theme.palette[3],
        })
    }
}

impl HerdrWindow {
    /// Replaces whatever flash is up, so the newest gesture is the one answered.
    pub(crate) fn show_flash(&mut self, flash: Flash, cx: &mut Context<Self>) {
        self.flash = Some((flash, Instant::now() + FLASH_DURATION));
        cx.notify();
    }

    /// Retires the flash once its time is up. `true` when the window has to
    /// repaint without it.
    pub(crate) fn tick_flash(&mut self, now: Instant) -> bool {
        if self
            .flash
            .as_ref()
            .is_none_or(|(_, expires)| now < *expires)
        {
            return false;
        }
        self.flash = None;
        true
    }
}
