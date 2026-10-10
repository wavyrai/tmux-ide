//! Showing native pages to match what the window draws, and the pictures
//! covered pages leave while a menu is open.

use crate::HerdrWindow;
#[cfg(any(target_os = "macos", windows))]
use crate::browser::TabId;
use gpui::*;

/// A page a menu covers. A native page sits above everything the window
/// draws, so it steps aside for the menu, leaving a picture of itself.
#[cfg(any(target_os = "macos", windows))]
pub(super) enum Freeze {
    /// The picture was asked for, while the page still shows: WebKit only
    /// pictures a page on screen.
    Asked(std::time::Instant),
    /// Only macOS takes pictures.
    #[cfg(target_os = "macos")]
    Ready(std::sync::Arc<RenderImage>),
    /// No picture came in time, or this platform takes none.
    Blank,
}

/// How long a covered page may keep showing while its picture is taken and
/// decoded.
#[cfg(any(target_os = "macos", windows))]
const FREEZE_WAIT: std::time::Duration = std::time::Duration::from_millis(300);

impl HerdrWindow {
    /// Shows or hides the native pages to match what the window draws. The
    /// pages sit above everything GPUI paints, so a page an open menu covers
    /// steps aside, leaving a picture of itself where it can; a page the menu
    /// does not reach keeps showing. Returns whether another frame is needed
    /// to settle, while a menu is first laid out or a picture is on its way.
    pub(crate) fn present_browser(&mut self, cx: &mut Context<Self>) -> bool {
        #[cfg(any(target_os = "macos", windows))]
        {
            use crate::menu::Cover;
            let live = self.live_pages(cx);
            if self.menu.page.is_none() {
                self.browser.frozen.clear();
                self.browser.pages.present(&live, cx);
                return false;
            }
            let cover = self.menu.cover.get();
            let bounds = self.browser.page_bounds.borrow().clone();
            let now = std::time::Instant::now();
            let mut settling = cover == Cover::Unknown;
            let mut shown = Vec::new();
            for id in live {
                let covered = cover.covers(bounds.get(&id).copied());
                if !covered {
                    shown.push(id);
                    continue;
                }
                match self.browser.frozen.get(&id) {
                    None => {
                        let asked = bounds
                            .get(&id)
                            .is_some_and(|page| self.browser.pages.freeze(id, page.size, cx));
                        let freeze = if asked {
                            shown.push(id);
                            settling = true;
                            Freeze::Asked(now)
                        } else {
                            Freeze::Blank
                        };
                        self.browser.frozen.insert(id, freeze);
                    }
                    Some(Freeze::Asked(since)) if now.duration_since(*since) < FREEZE_WAIT => {
                        shown.push(id);
                        settling = true;
                    }
                    Some(Freeze::Asked(_)) => {
                        self.browser.frozen.insert(id, Freeze::Blank);
                    }
                    #[cfg(target_os = "macos")]
                    Some(Freeze::Ready(_)) => {}
                    Some(Freeze::Blank) => {}
                }
            }
            self.browser.pages.present(&shown, cx);
            settling
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            let _ = cx;
            false
        }
    }

    /// Decodes a covered page's picture off the UI thread, and has the page
    /// step aside only once it can be painted in the same frame, so there is
    /// never an empty frame between the page and its picture. A picture that
    /// arrives after the menu closed, or after the wait ran out, is dropped.
    #[cfg(target_os = "macos")]
    pub(super) fn page_frozen(&mut self, id: TabId, tiff: Option<Vec<u8>>, cx: &mut Context<Self>) {
        let waiting =
            move |this: &Self| matches!(this.browser.frozen.get(&id), Some(Freeze::Asked(_)));
        if !waiting(self) {
            return;
        }
        let Some(tiff) = tiff else {
            self.browser.frozen.insert(id, Freeze::Blank);
            cx.notify();
            return;
        };
        let frame = cx
            .background_executor()
            .spawn(async move { crate::browser::snapshot::frame(&tiff) });
        cx.spawn(async move |this, cx| {
            let frame = frame.await;
            this.update(cx, |this, cx| {
                if waiting(this) {
                    let freeze = frame.map_or(Freeze::Blank, |frame| {
                        Freeze::Ready(std::sync::Arc::new(frame))
                    });
                    this.browser.frozen.insert(id, freeze);
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    /// The picture a covered page left, while a menu is open.
    #[cfg(any(target_os = "macos", windows))]
    pub(super) fn frozen_picture(&self, id: TabId) -> Option<std::sync::Arc<RenderImage>> {
        match self.browser.frozen.get(&id)? {
            #[cfg(target_os = "macos")]
            Freeze::Ready(image) if self.menu.page.is_some() => Some(image.clone()),
            _ => None,
        }
    }
}
