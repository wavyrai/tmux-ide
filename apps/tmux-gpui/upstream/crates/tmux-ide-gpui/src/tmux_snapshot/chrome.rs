//! The window's chrome material, from Bezel: the platform blurs what is behind
//! the window, and the palette's frost paints the sidebar and titlebar over it.
//! Terminal panes stay opaque. Reduce Transparency and Increase Contrast turn
//! the material off. Reduce Motion turns Bezel's motion off (#761).
use gpui::{App, Window, WindowBackgroundAppearance};
#[cfg(target_os = "macos")]
mod macos;

/// The one place the window's background is set, so tests can see what the
/// window was actually told.
fn set_window_background(window: &mut Window, background: WindowBackgroundAppearance) {
    #[cfg(test)]
    PASSED.with(|passed| passed.set(Some(background)));
    window.set_background_appearance(background);
}

#[cfg(test)]
thread_local! {
    static PASSED: std::cell::Cell<Option<WindowBackgroundAppearance>> =
        const { std::cell::Cell::new(None) };
}

/// The background last passed to a window on this thread.
#[cfg(test)]
pub(super) fn passed_to_window() -> Option<WindowBackgroundAppearance> {
    PASSED.with(std::cell::Cell::get)
}

#[derive(Default)]
pub(super) struct Chrome {
    applied: Option<WindowBackgroundAppearance>,
    allowed: bool,
    #[cfg(target_os = "macos")]
    watcher: Option<macos::Watcher>,
    /// Tests stand in for the accessibility settings here.
    #[cfg(test)]
    forced: Option<bool>,
    /// Tests and offscreen captures stand in for Reduce Motion here. Unset,
    /// tests draw with motion reduced, so every frame they paint is the
    /// settled one.
    #[cfg(any(test, feature = "visual-capture"))]
    forced_motion: Option<bool>,
}
impl Chrome {
    /// Whether accessibility settings allow translucent chrome, as of the last
    /// [`Self::sync`]. Every caller of `design::prepare` in one frame passes
    /// this, so they agree on the palette.
    pub(super) fn allowed(&self) -> bool {
        self.allowed
    }

    /// Reads the accessibility settings. Runs once per render, before the
    /// palette is prepared.
    pub(super) fn refresh(&mut self) -> bool {
        #[cfg(test)]
        if let Some(allowed) = self.forced {
            self.allowed = allowed;
            return allowed;
        }
        #[cfg(target_os = "macos")]
        {
            if self.watcher.is_none() {
                self.watcher = macos::Watcher::new();
            }
            self.allowed = macos::translucency_allowed();
        }
        self.allowed
    }

    /// Hands macOS "Reduce motion" to gpui (#761), which then draws every
    /// Bezel entrance at its end state and schedules no frames for it. Runs
    /// once per render, before the chrome is built; the accessibility
    /// watcher redraws the view when the setting changes.
    pub(super) fn sync_motion(&self, cx: &mut App) {
        use bezel_motion::AppExt as _;
        let reduced = self.motion_reduced();
        if cx.reduced_motion() != reduced {
            cx.set_reduced_motion(reduced);
        }
    }

    fn motion_reduced(&self) -> bool {
        #[cfg(test)]
        {
            self.forced_motion.unwrap_or(true)
        }
        #[cfg(not(test))]
        {
            #[cfg(feature = "visual-capture")]
            if let Some(reduced) = self.forced_motion {
                return reduced;
            }
            #[cfg(target_os = "macos")]
            {
                macos::motion_reduced()
            }
            #[cfg(not(target_os = "macos"))]
            {
                false
            }
        }
    }

    /// Draws as if macOS "Reduce motion" were `reduced`.
    #[cfg(any(test, feature = "visual-capture"))]
    pub(super) fn force_motion(&mut self, reduced: bool) {
        self.forced_motion = Some(reduced);
    }

    /// Puts the window's background where the installed palette wants it:
    /// blurred behind frosted chrome, or opaque. Returns whether the chrome
    /// is frosted.
    pub(super) fn sync(&mut self, window: &mut Window, cx: &App) -> bool {
        let theme = bezel_theme::Theme::of(cx);
        let wanted = theme.window_background_appearance();
        if self.applied != Some(wanted) {
            set_window_background(window, wanted);
            self.applied = Some(wanted);
        }
        theme.vibrancy
    }

    /// Answers [`Self::refresh`] as if the accessibility settings said
    /// `allowed`.
    #[cfg(test)]
    pub(super) fn force(&mut self, allowed: bool) {
        self.forced = Some(allowed);
    }

    /// True once after the accessibility settings change, so the view redraws.
    pub(super) fn take_policy_change(&self) -> bool {
        #[cfg(target_os = "macos")]
        {
            self.watcher.as_ref().is_some_and(macos::Watcher::take)
        }
        #[cfg(not(target_os = "macos"))]
        {
            false
        }
    }
}
