//! One window's native web views, one per browser tab it has shown. A view
//! is a platform child view layered above the GPUI surface: one per side of a
//! split is visible, and the window hides them while an overlay is open.
use super::{Location, Tab, TabId, WebUrl, location::PREVIEW_SCHEME, preview::Preview};
use gpui::{App, AppContext as _, Entity, Window};
use gpui_wry::WebView;
use std::{
    collections::HashMap,
    rc::Rc,
    sync::mpsc::{self, Receiver, SyncSender, TrySendError},
};
#[cfg(target_os = "macos")]
use std::{
    collections::HashSet,
    sync::{Arc, Mutex, PoisonError},
};
use wry::raw_window_handle::HasWindowHandle;

/// Enough for a burst of title and load reports between two window ticks;
/// later ones are dropped rather than queued without bound.
const EVENT_CAPACITY: usize = 64;

/// What a page reported, from the tab `P` names. Handlers run on the
/// platform's callbacks, so they only queue these for the window to apply on
/// its next tick.
#[derive(Debug)]
pub(crate) enum Event<P = TabId> {
    Title(P, String),
    Loaded(P, String),
    /// The page asked for a new window, which becomes a new, unrelated tab.
    /// macOS asks for this only when it cannot build the popup itself.
    NewWindow(P, String),
    /// The page opened a popup, already built and linked to it, which the
    /// window adopts as a new tab. Only macOS builds them.
    #[cfg(target_os = "macos")]
    Opened(P, WebUrl, Source, super::popup::Popup),
    /// A popup's script closed it, which closes its tab.
    #[cfg(target_os = "macos")]
    Closed(P),
    /// A screenshot for a note, as TIFF bytes, or `None` when WebKit had
    /// none. Only macOS takes them.
    #[cfg(target_os = "macos")]
    Captured(P, u64, Option<Vec<u8>>),
    /// A picture of the whole page, as TIFF bytes, shown in its place while
    /// a menu covers it. Only macOS takes them.
    #[cfg(target_os = "macos")]
    Frozen(P, Option<Vec<u8>>),
    /// A message the annotation picker posted. Any script in the page can
    /// post one, so it is parsed as untrusted input.
    Posted(P, String),
}

/// The page a report came from. A popup's page exists before its tab does,
/// so its reports name the popup until the window adopts it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Source {
    Tab(TabId),
    #[cfg(target_os = "macos")]
    Popup(u64),
}

/// Popups are numbered across windows, so a key never names two.
#[cfg(target_os = "macos")]
static NEXT_POPUP: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

impl Event<Source> {
    /// The same report from the tab `tab` finds for its source, or `None`
    /// for a popup no tab adopted.
    fn resolve(self, tab: impl Fn(Source) -> Option<TabId>) -> Option<Event> {
        Some(match self {
            Self::Title(source, title) => Event::Title(tab(source)?, title),
            Self::Loaded(source, url) => Event::Loaded(tab(source)?, url),
            Self::NewWindow(source, url) => Event::NewWindow(tab(source)?, url),
            #[cfg(target_os = "macos")]
            Self::Opened(source, url, popup, page) => Event::Opened(tab(source)?, url, popup, page),
            #[cfg(target_os = "macos")]
            Self::Closed(source) => Event::Closed(tab(source)?),
            #[cfg(target_os = "macos")]
            Self::Captured(source, capture, tiff) => Event::Captured(tab(source)?, capture, tiff),
            #[cfg(target_os = "macos")]
            Self::Frozen(source, tiff) => Event::Frozen(tab(source)?, tiff),
            Self::Posted(source, body) => Event::Posted(tab(source)?, body),
        })
    }
}

/// Longer posts are dropped before they are queued.
const MAX_POST_BYTES: usize = 64 * 1024;

pub(crate) struct Pages {
    pages: HashMap<TabId, Entity<WebView>>,
    shown: Vec<TabId>,
    outbox: Outbox,
    events: Receiver<Event<Source>>,
    /// The tab each adopted popup became.
    #[cfg(target_os = "macos")]
    adopted: HashMap<u64, TabId>,
    /// Each adopted popup's UI delegate, which its view holds only weakly.
    #[cfg(target_os = "macos")]
    delegates: HashMap<TabId, objc2::rc::Retained<super::popup::Closer>>,
    /// Reads local pages' files; started with the first page.
    preview: Option<Rc<Preview>>,
}

impl Default for Pages {
    fn default() -> Self {
        let (sender, events) = mpsc::sync_channel(EVENT_CAPACITY);
        Self {
            pages: HashMap::new(),
            shown: Vec::new(),
            outbox: Outbox {
                sender,
                #[cfg(target_os = "macos")]
                closed: Arc::default(),
            },
            events,
            #[cfg(target_os = "macos")]
            adopted: HashMap::new(),
            #[cfg(target_os = "macos")]
            delegates: HashMap::new(),
            preview: None,
        }
    }
}

/// Where a page's handlers send what it reports.
#[derive(Clone)]
struct Outbox {
    sender: SyncSender<Event<Source>>,
    /// Popups whose script closed them. A close must not be dropped with
    /// the queue full, or its tab would stay, so these wait here instead:
    /// at most one entry per popup.
    #[cfg(target_os = "macos")]
    closed: Arc<Mutex<HashSet<u64>>>,
}

fn report(sender: &SyncSender<Event<Source>>, event: Event<Source>) {
    if let Err(TrySendError::Full(event)) = sender.try_send(event) {
        tracing::debug!(?event, "Dropped a browser event");
    }
}

/// The handlers every page has, its own or a popup's, reporting as `source`.
fn with_handlers<'a>(
    builder: wry::WebViewBuilder<'a>,
    source: Source,
    outbox: &Outbox,
) -> wry::WebViewBuilder<'a> {
    let (title, loaded, popup) = (outbox.sender.clone(), outbox.sender.clone(), outbox.clone());
    builder
        .with_devtools(cfg!(debug_assertions))
        .with_navigation_handler(|url| navigable(&url))
        .with_new_window_req_handler(move |url, features| new_window(source, url, features, &popup))
        // Nothing a page offers is saved to disk.
        .with_download_started_handler(|_, _| false)
        .with_document_title_changed_handler(move |text| {
            report(&title, Event::Title(source, text));
        })
        .with_on_page_load_handler(move |event, url| {
            if matches!(event, wry::PageLoadEvent::Finished) {
                report(&loaded, Event::Loaded(source, url));
            }
        })
}

/// Answers a page's request for a new window. On macOS the popup is built
/// now, linked to its opener; elsewhere, or when that fails, the address
/// opens in a new, unrelated tab.
fn new_window(
    opener: Source,
    url: String,
    features: wry::NewWindowFeatures,
    outbox: &Outbox,
) -> wry::NewWindowResponse {
    #[cfg(target_os = "macos")]
    if let (Some(mtm), Ok(address)) = (objc2::MainThreadMarker::new(), WebUrl::try_from(&*url)) {
        let key = NEXT_POPUP.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let source = Source::Popup(key);
        let builder = with_handlers(wry::WebViewBuilder::new(), source, outbox);
        let closed = outbox.closed.clone();
        let built = super::popup::build(
            builder,
            features.opener,
            move || {
                closed
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .insert(key);
            },
            mtm,
        );
        match built {
            Ok(popup) => {
                let webview = popup.webview(mtm);
                // A popup the window never hears of would stay hidden.
                return match outbox
                    .sender
                    .try_send(Event::Opened(opener, address, source, popup))
                {
                    Ok(()) => wry::NewWindowResponse::Create { webview },
                    Err(_) => wry::NewWindowResponse::Deny,
                };
            }
            Err(error) => tracing::debug!(%error, "Cannot build a popup"),
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = features;
    report(&outbox.sender, Event::NewWindow(opener, url));
    wry::NewWindowResponse::Deny
}

/// Pages leave only for web addresses and the preview scheme. Anything
/// else, such as `file:` or an application's custom scheme, stays unopened
/// rather than reaching the OS.
fn navigable(url: &str) -> bool {
    url == "about:blank"
        || url.starts_with("about:srcdoc")
        || url.starts_with("herdr-preview://localhost/")
        || WebUrl::try_from(url).is_ok()
}

impl Pages {
    pub(crate) fn ids(&self) -> impl Iterator<Item = TabId> + '_ {
        self.pages.keys().copied()
    }

    pub(crate) fn contains(&self, id: TabId) -> bool {
        self.pages.contains_key(&id)
    }

    pub(crate) fn page(&self, id: TabId) -> Option<&Entity<WebView>> {
        self.pages.get(&id)
    }

    /// Creates the page for `tab` if this window has not shown it yet and it
    /// has an address. Creating one starts the platform's web content
    /// processes, so this runs from input and ticks, never from render.
    pub(crate) fn ensure(
        &mut self,
        tab: &Tab,
        window: &mut Window,
        cx: &mut App,
    ) -> crate::Result<()> {
        // A review tab is drawn by the app; only pages get a web view.
        let Some(location) = tab
            .location
            .as_ref()
            .filter(|location| location.is_page())
            .filter(|_| !self.pages.contains_key(&tab.id))
        else {
            return Ok(());
        };
        let id = tab.id;
        let posted = self.outbox.sender.clone();
        let preview = match &self.preview {
            Some(preview) => preview.clone(),
            None => {
                let preview = Rc::new(Preview::start()?);
                self.preview = Some(preview.clone());
                preview
            }
        };
        // The folder this page may read. A web page gets none, and a page
        // keeps the folder it was created with wherever it navigates.
        let root = match location {
            Location::Local { file } => Some(file.root().to_owned()),
            Location::Web { .. } | Location::Review { .. } => None,
        };
        let builder = with_handlers(wry::WebViewBuilder::new(), Source::Tab(id), &self.outbox)
            .with_url(location.page_url())
            .with_asynchronous_custom_protocol(
                PREVIEW_SCHEME.into(),
                move |_, request, responder| {
                    preview.handle(root.as_deref(), &request, responder);
                },
            )
            .with_ipc_handler(move |request| {
                let body = request.into_body();
                if body.len() <= MAX_POST_BYTES {
                    report(&posted, Event::Posted(Source::Tab(id), body));
                }
            });
        // Window has an inherent `window_handle` of its own.
        let handle = HasWindowHandle::window_handle(window)?;
        let view = builder.build_as_child(&handle)?;
        let page = cx.new(|cx| {
            let mut page = WebView::new(view, window, cx);
            // A new page appears only when the window presents it.
            page.hide();
            page
        });
        self.pages.insert(id, page);
        Ok(())
    }

    /// Shows the pages in `ids` and hides every other one; an empty list
    /// hides them all.
    pub(crate) fn present(&mut self, ids: &[TabId], cx: &mut App) {
        let ids: Vec<TabId> = ids
            .iter()
            .copied()
            .filter(|id| self.pages.contains_key(id))
            .collect();
        if self.shown == ids {
            return;
        }
        for id in self.shown.iter().filter(|id| !ids.contains(id)) {
            if let Some(page) = self.pages.get(id) {
                page.update(cx, |page, _| page.hide());
            }
        }
        for id in ids.iter().filter(|id| !self.shown.contains(id)) {
            if let Some(page) = self.pages.get(id) {
                page.update(cx, |page, _| page.show());
            }
        }
        self.shown = ids;
    }

    /// Makes `popup` the page of tab `id`, the tab the window opened for it.
    #[cfg(target_os = "macos")]
    pub(crate) fn adopt(
        &mut self,
        id: TabId,
        source: Source,
        popup: super::popup::Popup,
        window: &mut Window,
        cx: &mut App,
    ) {
        let Some(mtm) = objc2::MainThreadMarker::new() else {
            return;
        };
        let (view, delegate) = popup.into_parts(mtm);
        // It was built hidden, and appears when the window presents it.
        let page = cx.new(|cx| WebView::new(view, window, cx));
        self.pages.insert(id, page);
        self.delegates.insert(id, delegate);
        if let Source::Popup(key) = source {
            self.adopted.insert(key, id);
        }
    }

    pub(crate) fn close(&mut self, id: TabId) {
        #[cfg(target_os = "macos")]
        {
            self.adopted.retain(|_, tab| *tab != id);
            self.delegates.remove(&id);
        }
        self.shown.retain(|shown| *shown != id);
        // Dropping the entity hides the view; the platform releases it with
        // the last handle.
        self.pages.remove(&id);
    }

    /// Drops the pages of tabs the app no longer has.
    pub(crate) fn retain(&mut self, mut live: impl FnMut(TabId) -> bool) {
        let gone: Vec<_> = self.pages.keys().copied().filter(|id| !live(*id)).collect();
        for id in gone {
            self.close(id);
        }
    }

    pub(crate) fn load(&self, id: TabId, location: &Location, cx: &mut App) {
        let url = location.page_url();
        if let Some(page) = self.pages.get(&id) {
            page.update(cx, |page, _| page.load_url(&url));
        }
    }

    /// Runs one of the app's own scripts in the page. Never page-supplied
    /// text: data goes in as JSON.
    pub(crate) fn script(&self, id: TabId, script: &str, cx: &App) {
        if let Some(page) = self.pages.get(&id)
            && let Err(error) = page.read(cx).raw().evaluate_script(script)
        {
            tracing::debug!(%error, "Browser script failed");
        }
    }

    pub(crate) fn back(&self, id: TabId, cx: &App) {
        self.script(id, "history.back()", cx);
    }

    pub(crate) fn forward(&self, id: TabId, cx: &App) {
        self.script(id, "history.forward()", cx);
    }

    pub(crate) fn reload(&self, id: TabId, cx: &App) {
        if let Some(page) = self.pages.get(&id)
            && let Err(error) = page.read(cx).raw().reload()
        {
            tracing::debug!(%error, "Browser reload failed");
        }
    }

    /// Captures `rect` of the page, reporting it as `Event::Captured` with
    /// `capture` to match it to its note. Returns whether one was asked for:
    /// only macOS can take them.
    pub(crate) fn capture(
        &self,
        id: TabId,
        rect: super::annotate::Rect,
        capture: u64,
        cx: &App,
    ) -> bool {
        #[cfg(target_os = "macos")]
        if let Some(page) = self.pages.get(&id) {
            let sender = self.outbox.sender.clone();
            super::snapshot::capture(page.read(cx).raw(), rect, move |tiff| {
                report(&sender, Event::Captured(Source::Tab(id), capture, tiff));
            });
            return true;
        }
        let _ = (id, rect, capture, cx);
        false
    }

    /// Asks for a picture of the whole page, `size` in CSS pixels, reported
    /// as `Event::Frozen`. Returns whether one was asked for: only macOS
    /// takes them.
    pub(crate) fn freeze(&self, id: TabId, size: gpui::Size<gpui::Pixels>, cx: &App) -> bool {
        #[cfg(target_os = "macos")]
        if let Some(page) = self.pages.get(&id) {
            let sender = self.outbox.sender.clone();
            let rect = super::annotate::Rect {
                x: 0.,
                y: 0.,
                width: f64::from(f32::from(size.width)),
                height: f64::from(f32::from(size.height)),
            };
            super::snapshot::capture(page.read(cx).raw(), rect, move |tiff| {
                report(&sender, Event::Frozen(Source::Tab(id), tiff));
            });
            return true;
        }
        let _ = (id, size, cx);
        false
    }

    /// Hands the keyboard back from the page to the window.
    pub(crate) fn blur(&self, id: TabId, cx: &App) {
        if let Some(page) = self.pages.get(&id) {
            let _ = page.read(cx).raw().focus_parent();
        }
    }

    /// Moves keyboard input into the shown page.
    pub(crate) fn focus(&self, id: TabId, cx: &App) {
        if let Some(page) = self.pages.get(&id) {
            let _ = page.read(cx).raw().focus();
        }
    }

    /// The next thing the pages reported. One at a time, as the window
    /// adopts a popup between its report and the popup's own.
    pub(crate) fn next_event(&self) -> Option<Event> {
        while let Ok(event) = self.events.try_recv() {
            let resolved = event.resolve(|source| match source {
                Source::Tab(id) => Some(id),
                #[cfg(target_os = "macos")]
                Source::Popup(key) => self.adopted.get(&key).copied(),
            });
            if resolved.is_some() {
                return resolved;
            }
        }
        #[cfg(target_os = "macos")]
        return self.next_close();
        #[cfg(not(target_os = "macos"))]
        None
    }

    /// A popup that closed itself, once the queue is empty: its `Opened`
    /// report, queued before the popup ran any script, has been applied by
    /// then, so a popup no tab adopted is forgotten.
    #[cfg(target_os = "macos")]
    fn next_close(&self) -> Option<Event> {
        let mut closed = self
            .outbox
            .closed
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        while let Some(key) = closed.iter().next().copied() {
            closed.remove(&key);
            if let Some(tab) = self.adopted.get(&key) {
                return Some(Event::Closed(*tab));
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pages_only_navigate_to_web_addresses() {
        for allowed in [
            "https://a.test/",
            "http://localhost:3000/x",
            "about:blank",
            "herdr-preview://localhost/index.html",
        ] {
            assert!(navigable(allowed), "{allowed}");
        }
        for denied in [
            "file:///etc/passwd",
            "vscode://file/x",
            "mailto:a@b.test",
            "data:text/html,x",
            "herdr-preview://elsewhere/x",
        ] {
            assert!(!navigable(denied), "{denied}");
        }
    }

    #[test]
    fn page_reports_are_bounded() {
        let pages = Pages::default();
        for index in 0..EVENT_CAPACITY + 10 {
            report(
                &pages.outbox.sender,
                Event::Title(Source::Tab(TabId::test(0)), index.to_string()),
            );
        }
        assert_eq!(
            std::iter::from_fn(|| pages.next_event()).count(),
            EVENT_CAPACITY
        );
        assert!(pages.next_event().is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn popup_reports_wait_for_their_tab() {
        let mut pages = Pages::default();
        let (popup, tab) = (Source::Popup(7), TabId::test(3));
        let title = |text: &str| Event::Title(popup, text.to_owned());
        // A popup no tab adopted reports to no one.
        report(&pages.outbox.sender, title("before"));
        assert!(pages.next_event().is_none());
        pages.adopted.insert(7, tab);
        report(&pages.outbox.sender, title("after"));
        pages
            .outbox
            .closed
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(7);
        assert!(
            matches!(pages.next_event(), Some(Event::Title(id, text)) if id == tab && text == "after")
        );
        assert!(matches!(pages.next_event(), Some(Event::Closed(id)) if id == tab));
        // Its tab closing forgets it.
        pages.close(tab);
        report(&pages.outbox.sender, title("gone"));
        assert!(pages.next_event().is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn popup_closes_survive_a_full_queue() {
        let mut pages = Pages::default();
        let tab = TabId::test(4);
        pages.adopted.insert(5, tab);
        for index in 0..EVENT_CAPACITY + 10 {
            report(
                &pages.outbox.sender,
                Event::Title(Source::Popup(5), index.to_string()),
            );
        }
        // A close no tab adopted is forgotten rather than kept.
        pages
            .outbox
            .closed
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .extend([5, 6]);
        let events: Vec<Event> = std::iter::from_fn(|| pages.next_event()).collect();
        assert_eq!(events.len(), EVENT_CAPACITY + 1);
        assert!(matches!(events.last(), Some(Event::Closed(id)) if *id == tab));
        assert!(
            pages
                .outbox
                .closed
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .is_empty()
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn tab_reports_skip_unadopted_popups_in_order() {
        let pages = Pages::default();
        let tab = TabId::test(1);
        report(
            &pages.outbox.sender,
            Event::Title(Source::Popup(9), "lost".into()),
        );
        report(
            &pages.outbox.sender,
            Event::Loaded(Source::Tab(tab), "https://a.test/".into()),
        );
        assert!(matches!(pages.next_event(), Some(Event::Loaded(id, _)) if id == tab));
        assert!(pages.next_event().is_none());
    }
}
