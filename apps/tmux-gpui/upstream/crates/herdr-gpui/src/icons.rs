use gpui::{AssetSource, SharedString};
use std::borrow::Cow;

pub(super) struct Icons;

/// Declares each agent mark once: its variant, Herdr's canonical
/// `agent_label` identity, and the embedded asset named after that identity.
macro_rules! agent_icons {
    ($($variant:ident => $label:literal,)+) => {
        /// Canonical daemon identities, independent of editable display names.
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub(crate) enum AgentIcon {
            $($variant,)+
            Generic,
        }

        impl AgentIcon {
            const ALL: &[Self] = &[$(Self::$variant,)+ Self::Generic];

            pub(crate) fn from_identity(identity: Option<&str>) -> Self {
                match identity {
                    $(Some($label) => Self::$variant,)+
                    _ => Self::Generic,
                }
            }

            pub(crate) fn path(self) -> &'static str {
                match self {
                    $(Self::$variant => concat!("icons/agent-", $label, ".svg"),)+
                    Self::Generic => "icons/agent-generic.svg",
                }
            }

            fn bytes(self) -> &'static [u8] {
                match self {
                    $(Self::$variant => include_bytes!(concat!(
                        "../../../assets/icons/agent-", $label, ".svg"
                    )),)+
                    Self::Generic => include_bytes!("../../../assets/icons/agent-generic.svg"),
                }
            }
        }
    };
}

// Keyed on Herdr's `src/detect/mod.rs` `agent_label`, in its declaration order.
agent_icons! {
    Pi => "pi",
    Claude => "claude",
    Codex => "codex",
    Gemini => "gemini",
    Cursor => "cursor",
    Devin => "devin",
    Antigravity => "agy",
    Cline => "cline",
    Omp => "omp",
    Mastracode => "mastracode",
    OpenCode => "opencode",
    Copilot => "copilot",
    Kimi => "kimi",
    Kiro => "kiro",
    Droid => "droid",
    Amp => "amp",
    Grok => "grok",
    Hermes => "hermes",
    Kilo => "kilo",
    Qodercli => "qodercli",
    Qwen => "qwen",
    Letta => "letta",
    Maki => "maki",
    Muse => "muse",
}

/// Shared working-tree marker, distinct from the daemon's activity dots.
pub(super) fn uncommitted(theme: &crate::config::Theme, size: f32) -> gpui::Div {
    use gpui::{div, prelude::*, px, rgb, rgba, svg};
    div()
        .size(px(size))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(crate::config::corners::SMALL))
        .bg(rgba((theme.palette[3] << 8) | 0x30))
        .border_1()
        .border_color(rgba((theme.palette[3] << 8) | 0x90))
        .child(
            svg()
                .path("icons/pencil.svg")
                .size(px(size - 4.))
                .text_color(rgb(theme.ink(theme.palette[3]))),
        )
}

/// A checkout the user keeps a note on, beside the working-tree marker and
/// in a hue of its own so the two never read as one.
pub(super) fn note(theme: &crate::config::Theme, size: f32) -> gpui::Div {
    use gpui::{div, prelude::*, px, rgb, rgba, svg};
    div()
        .size(px(size))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(crate::config::corners::SMALL))
        .bg(rgba((theme.palette[4] << 8) | 0x30))
        .border_1()
        .border_color(rgba((theme.palette[4] << 8) | 0x90))
        .child(
            svg()
                .path("icons/note.svg")
                .size(px(size - 4.))
                .text_color(rgb(theme.ink(theme.palette[4]))),
        )
}

/// A checkout whose work was teleported to another host.
pub(super) fn teleported(theme: &crate::config::Theme, size: f32) -> gpui::Div {
    use gpui::{Rgba, div, prelude::*, px, svg};
    let color = crate::menu::teleported(theme);
    let faded = |a: f32| Rgba { a, ..color };
    div()
        .size(px(size))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(crate::config::corners::SMALL))
        .bg(faded(0.22))
        .border_1()
        .border_color(faded(0.7))
        .child(
            svg()
                .path("icons/teleport.svg")
                .size(px(size - 4.))
                .text_color(color),
        )
}

impl AssetSource for Icons {
    fn load(&self, path: &str) -> gpui::Result<Option<Cow<'static, [u8]>>> {
        if let Some(icon) = AgentIcon::ALL.iter().find(|icon| icon.path() == path) {
            return Ok(Some(Cow::Borrowed(icon.bytes())));
        }
        let bytes: &'static [u8] = match path {
            "icons/devices.svg" => include_bytes!("../../../assets/icons/devices.svg"),
            "icons/sessions.svg" => include_bytes!("../../../assets/icons/sessions.svg"),
            "icons/settings.svg" => include_bytes!("../../../assets/icons/settings.svg"),
            "icons/bell.svg" => include_bytes!("../../../assets/icons/bell.svg"),
            "icons/plus.svg" => include_bytes!("../../../assets/icons/plus.svg"),
            "icons/close.svg" => include_bytes!("../../../assets/icons/close.svg"),
            "icons/user.svg" => include_bytes!("../../../assets/icons/user.svg"),
            "icons/x.svg" => include_bytes!("../../../assets/icons/x.svg"),
            "icons/pencil.svg" => include_bytes!("../../../assets/icons/pencil.svg"),
            "icons/note.svg" => include_bytes!("../../../assets/icons/note.svg"),
            "icons/trash.svg" => include_bytes!("../../../assets/icons/trash.svg"),
            "icons/chevron-up.svg" => include_bytes!("../../../assets/icons/chevron-up.svg"),
            "icons/chevron-down.svg" => include_bytes!("../../../assets/icons/chevron-down.svg"),
            "icons/git-branch.svg" => include_bytes!("../../../assets/icons/git-branch.svg"),
            "icons/github.svg" => include_bytes!("../../../assets/icons/github.svg"),
            "icons/theme.svg" => include_bytes!("../../../assets/icons/theme.svg"),
            "icons/keyboard.svg" => include_bytes!("../../../assets/icons/keyboard.svg"),
            "icons/coffee.svg" => include_bytes!("../../../assets/icons/coffee.svg"),
            "icons/coffee-full.svg" => include_bytes!("../../../assets/icons/coffee-full.svg"),
            "icons/teleport.svg" => include_bytes!("../../../assets/icons/teleport.svg"),
            "icons/teleport-back.svg" => {
                include_bytes!("../../../assets/icons/teleport-back.svg")
            }
            "icons/refresh.svg" => include_bytes!("../../../assets/icons/refresh.svg"),
            "icons/play.svg" => include_bytes!("../../../assets/icons/play.svg"),
            "icons/chart.svg" => include_bytes!("../../../assets/icons/chart.svg"),
            "icons/pulse.svg" => include_bytes!("../../../assets/icons/pulse.svg"),
            "icons/lock.svg" => include_bytes!("../../../assets/icons/lock.svg"),
            "icons/globe.svg" => include_bytes!("../../../assets/icons/globe.svg"),
            "icons/terminal.svg" => include_bytes!("../../../assets/icons/terminal.svg"),
            "icons/arrow-left.svg" => include_bytes!("../../../assets/icons/arrow-left.svg"),
            "icons/arrow-right.svg" => include_bytes!("../../../assets/icons/arrow-right.svg"),
            "icons/external.svg" => include_bytes!("../../../assets/icons/external.svg"),
            "icons/split.svg" => include_bytes!("../../../assets/icons/split.svg"),
            "icons/fan-out.svg" => include_bytes!("../../../assets/icons/fan-out.svg"),
            "icons/more.svg" => include_bytes!("../../../assets/icons/more.svg"),
            "icons/zoom.svg" => include_bytes!("../../../assets/icons/zoom.svg"),
            "icons/diff-unified.svg" => include_bytes!("../../../assets/icons/diff-unified.svg"),
            "icons/diff-split.svg" => include_bytes!("../../../assets/icons/diff-split.svg"),
            "icons/chevron-right.svg" => {
                include_bytes!("../../../assets/icons/chevron-right.svg")
            }
            "icons/whitespace.svg" => include_bytes!("../../../assets/icons/whitespace.svg"),
            "icons/search.svg" => include_bytes!("../../../assets/icons/search.svg"),
            "icons/check.svg" => include_bytes!("../../../assets/icons/check.svg"),
            "icons/copy.svg" => include_bytes!("../../../assets/icons/copy.svg"),
            "icons/panel-left.svg" => include_bytes!("../../../assets/icons/panel-left.svg"),
            "icons/panel-right.svg" => include_bytes!("../../../assets/icons/panel-right.svg"),
            "icons/status-bar.svg" => include_bytes!("../../../assets/icons/status-bar.svg"),
            "icons/window-minimize.svg" => {
                include_bytes!("../../../assets/icons/window-minimize.svg")
            }
            "icons/window-maximize.svg" => {
                include_bytes!("../../../assets/icons/window-maximize.svg")
            }
            "icons/window-restore.svg" => {
                include_bytes!("../../../assets/icons/window-restore.svg")
            }
            _ => match crate::usage::icon(path) {
                Some(bytes) => bytes,
                None => return Ok(None),
            },
        };
        Ok(Some(Cow::Borrowed(bytes)))
    }

    fn list(&self, path: &str) -> gpui::Result<Vec<SharedString>> {
        Ok([
            "icons/devices.svg",
            "icons/sessions.svg",
            "icons/settings.svg",
            "icons/bell.svg",
            "icons/plus.svg",
            "icons/close.svg",
            "icons/user.svg",
            "icons/x.svg",
            "icons/pencil.svg",
            "icons/trash.svg",
            "icons/chevron-up.svg",
            "icons/chevron-down.svg",
            "icons/git-branch.svg",
            "icons/github.svg",
            "icons/theme.svg",
            "icons/keyboard.svg",
            "icons/coffee.svg",
            "icons/coffee-full.svg",
            "icons/teleport.svg",
            "icons/teleport-back.svg",
            "icons/refresh.svg",
            "icons/play.svg",
            "icons/chart.svg",
            "icons/pulse.svg",
            "icons/lock.svg",
            "icons/globe.svg",
            "icons/terminal.svg",
            "icons/arrow-left.svg",
            "icons/arrow-right.svg",
            "icons/external.svg",
            "icons/split.svg",
            "icons/fan-out.svg",
            "icons/more.svg",
            "icons/zoom.svg",
            "icons/diff-unified.svg",
            "icons/diff-split.svg",
            "icons/chevron-right.svg",
            "icons/whitespace.svg",
            "icons/search.svg",
            "icons/check.svg",
            "icons/panel-left.svg",
            "icons/panel-right.svg",
            "icons/status-bar.svg",
            "icons/window-minimize.svg",
            "icons/window-maximize.svg",
            "icons/window-restore.svg",
        ]
        .into_iter()
        .chain(AgentIcon::ALL.iter().map(|icon| icon.path()))
        .chain(crate::usage::icon_paths())
        .filter(|name| name.starts_with(path))
        .map(Into::into)
        .collect())
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use gpui::{DevicePixels, Image, ImageFormat, TestAppContext};

    #[gpui::test]
    fn embedded_icons_render_nonempty_masks(cx: &mut TestAppContext) {
        let renderer = cx.update(|cx| cx.svg_renderer());
        for path in Icons.list("icons/").unwrap() {
            let bytes = Icons.load(&path).unwrap().unwrap();
            // Decode through GPUI's SVG renderer; production uses svg() for tinting.
            let image = Image::from_bytes(ImageFormat::Svg, bytes.into_owned())
                .to_image_data(renderer.clone())
                .unwrap();
            // Square at its own scale: the tab and menu glyphs are drawn on a
            // 24px grid, GitHub's mark on its own 16px one.
            let rendered = image.size(0);
            assert_eq!(rendered.width, rendered.height, "{path}");
            assert!(rendered.width >= DevicePixels(16), "{path}");
            let pixels = image.as_bytes(0).unwrap();
            assert!(pixels.chunks_exact(4).any(|pixel| pixel[3] > 0));
            assert!(pixels.chunks_exact(4).any(|pixel| pixel[3] == 0));
        }
        assert!(Icons.load("unknown.svg").unwrap().is_none());
        assert_eq!(
            Icons.list("icons/").unwrap().len(),
            46 + AgentIcon::ALL.len() + crate::usage::icon_paths().count()
        );
    }

    /// Herdr's `agent_label` values, copied from `src/detect/mod.rs` at
    /// herdrdev/herdr 65e35a38. Update this list when Herdr adds an agent.
    const HERDR_AGENT_LABELS: [&str; 24] = [
        "pi",
        "claude",
        "codex",
        "gemini",
        "cursor",
        "devin",
        "agy",
        "cline",
        "omp",
        "mastracode",
        "opencode",
        "copilot",
        "kimi",
        "kiro",
        "droid",
        "amp",
        "grok",
        "hermes",
        "kilo",
        "qodercli",
        "qwen",
        "letta",
        "maki",
        "muse",
    ];

    #[test]
    fn every_herdr_agent_label_has_its_own_embedded_mark() {
        let listed = Icons.list("icons/agent-").unwrap();
        let mut seen = Vec::new();
        for label in HERDR_AGENT_LABELS {
            let icon = AgentIcon::from_identity(Some(label));
            assert_ne!(icon, AgentIcon::Generic, "{label}");
            assert_eq!(icon.path(), format!("icons/agent-{label}.svg"));
            assert!(Icons.load(icon.path()).unwrap().is_some(), "{label}");
            assert!(listed.iter().any(|path| path == icon.path()), "{label}");
            assert!(!seen.contains(&icon), "{label}");
            seen.push(icon);
        }
        // No marks for labels Herdr does not emit, beyond the fallback.
        assert_eq!(AgentIcon::ALL.len(), HERDR_AGENT_LABELS.len() + 1);
        assert_eq!(listed.len(), AgentIcon::ALL.len());
    }

    #[test]
    fn unknown_or_display_identities_use_the_generic_mark() {
        for identity in [
            Some("future-agent"),
            Some("Claude Code"),
            Some("kiro-cli"),
            Some("antigravity"),
            Some(""),
            None,
        ] {
            assert_eq!(AgentIcon::from_identity(identity), AgentIcon::Generic);
        }
        assert!(Icons.load(AgentIcon::Generic.path()).unwrap().is_some());
    }
}
