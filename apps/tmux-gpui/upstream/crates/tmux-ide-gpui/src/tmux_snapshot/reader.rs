//! The Markdown reader pane (#756). `tmux-ide open notes.md` splits a tmux pane
//! running `tmux-ide show`, and the daemon marks it with the file's name. The
//! app paints the file over that pane's card with bezel-markdown, read-only.
//!
//! - The app never opens the path: the daemon reads the file and the images it
//!   allows (the file's folder or its git repository) through the reader
//!   routes, locally and over SSH alike (`browser_native_local_reader.rs`).
//! - Remote images are never fetched and raw HTML stays text ([`policy`]).
//! - Links open the system browser for http and https only ([`ReaderLinks`]).
use bezel_markdown::Doc;
use std::sync::Arc;

#[path = "reader/find.rs"]
pub(super) mod find;
#[path = "reader/policy.rs"]
pub(super) mod policy;
#[path = "reader/view.rs"]
mod view;
pub(super) use view::Views;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) enum Status {
    #[default]
    Loading,
    Ready,
    /// Removed or renamed; the last content stays, dimmed.
    Missing,
    TooLarge(u64),
    /// Reads keep failing; the pane shows its terminal again.
    Unavailable,
    /// The daemon has no reader route.
    OldDaemon,
}

/// One reader pane as the worker publishes it.
#[derive(Clone, Debug, Default)]
pub(super) struct Published {
    pub name: String,
    /// The parent folder's name, shown dimmed after the file name.
    pub folder: String,
    pub status: Status,
    /// The document as painted: images point at the app's cache or are text.
    pub doc: Option<Arc<Doc>>,
    /// Some bytes were not UTF-8 and show as U+FFFD.
    pub lossy: bool,
    /// Counts the contents read; a new value is a reload.
    pub generation: u64,
}

/// What a click on a link in a reader does. Nothing else in the app paints
/// bezel-markdown, so this is the app's one link policy for it.
pub(super) struct ReaderLinks;

impl bezel_markdown::Links for ReaderLinks {
    fn open(link: bezel_markdown::Link<'_>, _: &mut gpui::Window, cx: &mut gpui::App) {
        if let policy::LinkAction::Web(url) = policy::link_action(link.url) {
            cx.open_url(&url);
        }
    }

    fn hover(
        link: bezel_markdown::Link<'_>,
        _: &mut gpui::Window,
        cx: &mut gpui::App,
    ) -> Option<gpui::AnyElement> {
        use gpui::prelude::*;
        let text: gpui::SharedString = match policy::link_action(link.url) {
            policy::LinkAction::Jump => return None,
            policy::LinkAction::Web(url) => url.chars().take(200).collect::<String>().into(),
            policy::LinkAction::Refused => "Link not opened".into(),
        };
        let theme = bezel_theme::Theme::of(cx);
        Some(
            gpui::div()
                .px_2()
                .py_1()
                .rounded_md()
                .bg(theme.surface_overlay)
                .border_1()
                .border_color(theme.border)
                .text_color(theme.text)
                .text_xs()
                .child(text)
                .into_any_element(),
        )
    }
}
