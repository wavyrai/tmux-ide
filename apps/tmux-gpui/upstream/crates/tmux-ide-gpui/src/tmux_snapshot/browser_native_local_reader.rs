//! Reader panes' file and image reads (#756). Requests go out on their own
//! catalog worker, one at a time, so terminal delivery never waits for a
//! daemon round trip. Decoding, parsing, rewriting images and admitting them
//! run on the reader work thread (`reader::work`), never on this actor, which
//! also carries terminal input; this actor only assembles pages and sends jobs.
//!
//! A visible reader is polled every 750 ms with the revision it shows. Each
//! poll costs the daemon what a browser toolbar poll costs: a catalog read
//! (`tmux list-panes -a`), the terminal inventory, and two `display-message`
//! calls to prove the pane before and after, plus a stat of the file; an
//! unchanged file sends no bytes. Visible readers are polled in turn
//! (round-robin), so with several readers over a slow link none starves.
use super::*;
use crate::tmux_snapshot::reader::{
    Published, Status,
    policy::Asset,
    work::{Done, Job as Work, Kitchen, PIXEL_BUDGET},
};
use herdr_client::tmux_daemon::{
    EditorTarget, ImageMime, ReaderAsset, ReaderChunk, ReaderFile, ReaderPage, ReaderReply,
};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

/// How often a visible reader asks whether its file changed.
pub(in crate::tmux_snapshot) const POLL: Duration = Duration::from_millis(750);
/// Failed reads in a row before the reader says it cannot read the file.
const FAILURE_LIMIT: u8 = 4;

enum Job {
    File,
    Asset(String),
}
struct Pending {
    route: String,
    request: u64,
    pane: String,
    job: Job,
}
/// A page sequence being put back together.
struct Progress {
    revision: String,
    bytes: Vec<u8>,
}
struct AssetProgress {
    src: String,
    mime: ImageMime,
    progress: Progress,
}
#[derive(Default)]
struct PaneFetch {
    name: String,
    folder: String,
    source: Option<(String, Arc<bezel_markdown::Doc>, bool)>,
    /// The source with its images rewritten, as last rendered by the work thread.
    rendered: Option<Arc<bezel_markdown::Doc>>,
    /// The latest render asked for; an older render's result is dropped.
    ticket: u64,
    /// A new source whose first render is still to come.
    fresh: bool,
    /// Decoded pixels of each cached picture, against the document's budget.
    pixels: BTreeMap<String, u64>,
    /// Pictures being admitted on the work thread. At most one at a time, so
    /// that each store sees the budget the ones before it left.
    storing: std::collections::BTreeSet<String>,
    progress: Option<Progress>,
    asset: Option<AssetProgress>,
    assets: BTreeMap<String, Asset>,
    wanted: Vec<String>,
    status: Status,
    due: Option<Instant>,
    failures: u8,
    generation: u64,
}
#[derive(Default)]
pub(in crate::tmux_snapshot) struct Gate {
    worker: Option<CatalogWorker>,
    pending: Option<Pending>,
    panes: BTreeMap<String, PaneFetch>,
    cache: Option<tempfile::TempDir>,
    kitchen: Option<Kitchen>,
    /// The pane polled last: the next poll starts after it.
    last: Option<String>,
}

/// Appends a page to a read in progress. `None` when the page does not continue
/// it, which restarts the read.
fn assemble(progress: Option<Progress>, chunk: ReaderChunk) -> Option<Progress> {
    match progress {
        _ if chunk.offset == 0 => Some(Progress {
            revision: chunk.revision,
            bytes: chunk.bytes,
        }),
        Some(mut held)
            if held.revision == chunk.revision && held.bytes.len() as u64 == chunk.offset =>
        {
            held.bytes.extend_from_slice(&chunk.bytes);
            Some(held)
        }
        _ => None,
    }
}

/// The readers to serve, in turn: none in the background, only visible ones,
/// starting after the one served last so that none starves.
fn order<'a>(
    foreground: bool,
    panes: impl Iterator<Item = &'a String>,
    visible: impl Fn(&str) -> bool,
    last: Option<&str>,
) -> Vec<String> {
    if !foreground {
        return Vec::new();
    }
    let mut order: Vec<String> = panes.filter(|pane| visible(pane)).cloned().collect();
    if let Some(at) = last.and_then(|last| order.iter().position(|pane| pane == last)) {
        order.rotate_left(at + 1);
    }
    order
}

fn page_of(progress: Option<&Progress>) -> Option<ReaderPage> {
    progress.map(|p| ReaderPage {
        revision: p.revision.clone(),
        offset: p.bytes.len() as u64,
    })
}

impl Local {
    fn reader_target(&self, pane: &str) -> Option<(ServerScope, EditorTarget, String, u64)> {
        let route = self.active.as_ref()?;
        Some((
            route.target.scope.clone(),
            EditorTarget {
                generation: route.target.scope.generation.clone(),
                workspace_name: route.workspace.clone(),
                live_session_id: route.target.live.clone(),
                semantic_pane_id: pane.to_owned(),
            },
            route.id.clone(),
            route.request,
        ))
    }
    /// Sends a job to the work thread, starting it on first use.
    fn reader_work(&mut self, job: Work) -> bool {
        let gate = &mut self.browser_controls.reader;
        if gate.kitchen.is_none() {
            gate.kitchen = Kitchen::spawn().ok();
        }
        gate.kitchen
            .as_ref()
            .is_some_and(|kitchen| kitchen.send(job))
    }
    /// Asks for the pane's document to be rendered again with its images.
    fn reader_render(&mut self, pane: &str) {
        let Some(fetch) = self.browser_controls.reader.panes.get_mut(pane) else {
            return;
        };
        let Some((_, doc, _)) = &fetch.source else {
            return;
        };
        fetch.ticket += 1;
        let job = Work::Render {
            pane: pane.to_owned(),
            ticket: fetch.ticket,
            doc: doc.clone(),
            assets: fetch.assets.clone(),
        };
        self.reader_work(job);
    }
    /// Takes the work thread's results. True when a publication changed.
    fn reader_finished(&mut self) -> bool {
        let mut changed = false;
        while let Some(done) = self
            .browser_controls
            .reader
            .kitchen
            .as_ref()
            .and_then(Kitchen::poll)
        {
            let pane = match &done {
                Done::Parsed { pane, .. }
                | Done::Rendered { pane, .. }
                | Done::Stored { pane, .. } => pane.clone(),
            };
            let Some(fetch) = self.browser_controls.reader.panes.get_mut(&pane) else {
                continue;
            };
            match done {
                Done::Parsed {
                    revision,
                    doc,
                    lossy,
                    ..
                } => {
                    fetch.source = Some((revision, doc, lossy));
                    fetch
                        .assets
                        .retain(|_, asset| matches!(asset, Asset::Ready(_)));
                    let assets = &fetch.assets;
                    fetch.pixels.retain(|src, _| assets.contains_key(src));
                    fetch.fresh = true;
                    self.reader_render(&pane);
                }
                Done::Rendered {
                    ticket,
                    doc,
                    wanted,
                    ..
                } => {
                    if fetch.take_render(ticket, doc, wanted) {
                        self.reader_refresh(&pane);
                        changed = true;
                    }
                }
                Done::Stored {
                    src, asset, pixels, ..
                } => {
                    fetch.storing.remove(&src);
                    if pixels > 0 {
                        fetch.pixels.insert(src.clone(), pixels);
                    }
                    fetch.assets.insert(src, asset);
                    self.reader_render(&pane);
                }
            }
        }
        changed
    }
    /// Republishes one pane's reader from what is held.
    fn reader_refresh(&mut self, pane: &str) {
        let Some(fetch) = self.browser_controls.reader.panes.get_mut(pane) else {
            return;
        };
        let published = Published {
            name: fetch.name.clone(),
            folder: fetch.folder.clone(),
            status: fetch.status.clone(),
            doc: fetch.rendered.clone().filter(|_| fetch.source.is_some()),
            lossy: fetch.source.as_ref().is_some_and(|(_, _, lossy)| *lossy),
            generation: fetch.generation,
        };
        self.state
            .readers
            .insert(pane.to_owned(), Arc::new(published));
    }
    pub(super) fn reader_tick(&mut self) -> Result<(), Error> {
        let names = self.state.reader_panes.clone();
        let gate = &mut self.browser_controls.reader;
        gate.panes.retain(|pane, _| names.contains_key(pane));
        let before = self.state.readers.len();
        self.state
            .readers
            .retain(|pane, _| names.contains_key(pane));
        let mut changed = before != self.state.readers.len();
        for (pane, name) in &names {
            let fetch = gate.panes.entry(pane.clone()).or_default();
            if fetch.name.is_empty() {
                fetch.name = name.clone();
                changed = true;
            }
        }
        for pane in names.keys() {
            if !self.state.readers.contains_key(pane) {
                self.reader_refresh(pane);
            }
        }
        if let Some(worker) = &mut self.browser_controls.reader.worker
            && let Some(result) = worker.poll()?
        {
            changed |= self.reader_reply(result);
        }
        changed |= self.reader_finished();
        if changed {
            self.publish()?;
        }
        if self.browser_controls.reader.pending.is_none() {
            self.reader_dispatch()?;
        }
        Ok(())
    }
    fn reader_dispatch(&mut self) -> Result<(), Error> {
        if self.active.is_none() {
            return Ok(());
        }
        let now = Instant::now();
        let gate = &self.browser_controls.reader;
        let visible = order(
            self.foreground,
            gate.panes.keys(),
            |pane| self.state.browser_pane_visible(pane),
            gate.last.as_deref(),
        );
        let mut next: Option<(String, Job, Option<String>, Option<ReaderPage>)> = None;
        for pane in &visible {
            let fetch = &gate.panes[pane];
            if fetch.progress.is_some() {
                next = Some((
                    pane.clone(),
                    Job::File,
                    None,
                    page_of(fetch.progress.as_ref()),
                ));
                break;
            }
            if let Some(asset) = &fetch.asset {
                let page = page_of(Some(&asset.progress));
                next = Some((pane.clone(), Job::Asset(asset.src.clone()), None, page));
                break;
            }
        }
        if next.is_none() {
            next = visible.iter().find_map(|pane| {
                let fetch = &gate.panes[pane];
                fetch.due.is_none_or(|due| due <= now).then(|| {
                    let have = fetch.source.as_ref().map(|(rev, _, _)| rev.clone());
                    (pane.clone(), Job::File, have, None)
                })
            });
        }
        if next.is_none() {
            next = visible.iter().find_map(|pane| {
                let src = gate.panes[pane].next_asset()?;
                Some((pane.clone(), Job::Asset(src.to_owned()), None, None))
            });
        }
        let Some((pane, job, have, page)) = next else {
            return Ok(());
        };
        let Some((scope, target, route, request)) = self.reader_target(&pane) else {
            return Ok(());
        };
        let action = match &job {
            Job::File => CatalogAction::Reader {
                scope,
                target,
                have,
                page,
            },
            Job::Asset(src) => CatalogAction::ReaderAsset {
                scope,
                target,
                src: src.clone(),
                page,
            },
        };
        if self.browser_controls.reader.worker.is_none() {
            self.browser_controls.reader.worker = Some(CatalogWorker::spawn_source(
                self.sources.observation_source()?,
            )?);
        }
        if let Some(worker) = &mut self.browser_controls.reader.worker {
            worker.submit(action)?;
            self.browser_controls.reader.last = Some(pane.clone());
            self.browser_controls.reader.pending = Some(Pending {
                route,
                request,
                pane,
                job,
            });
        }
        Ok(())
    }
    /// Applies one reply. True when the pane's publication changed.
    fn reader_reply(
        &mut self,
        result: Result<CatalogResult, herdr_client::tmux_daemon::Error>,
    ) -> bool {
        let Some(pending) = self.browser_controls.reader.pending.take() else {
            return false;
        };
        if !self
            .active
            .as_ref()
            .is_some_and(|r| r.id == pending.route && r.request == pending.request)
        {
            return false;
        }
        let pane = pending.pane.clone();
        let changed = match (pending.job, result) {
            (Job::File, Ok(CatalogResult::Reader(reply))) => self.reader_file(&pane, reply),
            (Job::Asset(src), Ok(CatalogResult::ReaderAsset(asset))) => {
                self.reader_asset(&pane, src, asset)
            }
            (job, _) => {
                let gate = &mut self.browser_controls.reader;
                let Some(fetch) = gate.panes.get_mut(&pane) else {
                    return false;
                };
                if let Job::Asset(src) = job {
                    fetch.asset = None;
                    fetch.assets.insert(src, Asset::Failed);
                    true
                } else {
                    fetch.progress = None;
                    fetch.failures = fetch.failures.saturating_add(1);
                    let status = if fetch.failures >= FAILURE_LIMIT {
                        Status::Unavailable
                    } else {
                        fetch.status.clone()
                    };
                    let backoff = POLL * u32::from(fetch.failures.min(8));
                    fetch.due = Some(Instant::now() + backoff);
                    let changed = status != fetch.status;
                    fetch.status = status;
                    changed
                }
            }
        };
        if changed {
            // An image's outcome or a status: render again on the work thread.
            self.reader_render(&pane);
            self.reader_refresh(&pane);
        }
        changed
    }
    fn reader_file(&mut self, pane: &str, reply: ReaderReply) -> bool {
        let Some(fetch) = self.browser_controls.reader.panes.get_mut(pane) else {
            return false;
        };
        let mut changed = fetch.name != reply.name || fetch.folder != reply.folder;
        fetch.name = reply.name;
        fetch.folder = reply.folder;
        fetch.failures = 0;
        let now = Instant::now();
        let mut parse = None;
        let status = match reply.file {
            ReaderFile::Unchanged { .. } => {
                fetch.due = Some(now + POLL);
                Status::Ready
            }
            ReaderFile::Page(chunk) => {
                let size = chunk.size;
                fetch.progress = assemble(fetch.progress.take(), chunk);
                match fetch.progress.take_if(|p| p.bytes.len() as u64 == size) {
                    Some(done) => {
                        // Parsed on the work thread; shown once rendered.
                        fetch.due = Some(now + POLL);
                        parse = Some(Work::Parse {
                            pane: pane.to_owned(),
                            revision: done.revision,
                            bytes: done.bytes,
                        });
                        Status::Ready
                    }
                    // Mid-read: the next page goes out on the next tick.
                    None => fetch.status.clone(),
                }
            }
            ReaderFile::Changed => {
                fetch.progress = None;
                fetch.due = None;
                fetch.status.clone()
            }
            ReaderFile::TooLarge { size } => {
                fetch.progress = None;
                fetch.source = None;
                fetch.due = Some(now + POLL);
                Status::TooLarge(size)
            }
            ReaderFile::Missing => {
                fetch.progress = None;
                fetch.due = Some(now + POLL);
                Status::Missing
            }
        };
        changed |= status != fetch.status;
        fetch.status = status;
        if let Some(job) = parse {
            self.reader_work(job);
        }
        changed
    }
    fn reader_asset(&mut self, pane: &str, src: String, asset: ReaderAsset) -> bool {
        let gate = &mut self.browser_controls.reader;
        if gate.cache.is_none() {
            gate.cache = tempfile::Builder::new()
                .prefix("tmux-ide-reader-")
                .tempdir()
                .ok();
        }
        let Some(fetch) = gate.panes.get_mut(pane) else {
            return false;
        };
        let held = fetch.asset.take().filter(|a| a.src == src);
        let done = match asset {
            ReaderAsset::Page { mime, chunk } => {
                let size = chunk.size;
                let progress = assemble(held.filter(|a| a.mime == mime).map(|a| a.progress), chunk);
                match progress {
                    Some(p) if p.bytes.len() as u64 == size => match &gate.cache {
                        // Admitted and cached on the work thread, within what is
                        // left of the document's pixel budget.
                        Some(cache) => {
                            fetch.storing.insert(src.clone());
                            let job = Work::Store {
                                pane: pane.to_owned(),
                                src: src.clone(),
                                mime,
                                bytes: p.bytes,
                                cache: cache.path().to_owned(),
                                budget: fetch.budget_left(),
                            };
                            if self.reader_work(job) {
                                return false;
                            }
                            // No work thread: the picture fails rather than
                            // waiting in `storing` for ever.
                            let Some(fetch) = self.browser_controls.reader.panes.get_mut(pane)
                            else {
                                return false;
                            };
                            fetch.storing.remove(&src);
                            fetch.assets.insert(src, Asset::Failed);
                            return true;
                        }
                        None => Some(Asset::Failed),
                    },
                    Some(progress) => {
                        fetch.asset = Some(AssetProgress {
                            src: src.clone(),
                            mime,
                            progress,
                        });
                        None
                    }
                    None => None,
                }
            }
            ReaderAsset::Changed => None,
            ReaderAsset::Refused => Some(Asset::Refused),
            ReaderAsset::Missing => Some(Asset::Missing),
            ReaderAsset::TooLarge => Some(Asset::TooLarge),
        };
        let Some(done) = done else {
            return false;
        };
        fetch.assets.insert(src, done);
        true
    }
}

impl PaneFetch {
    /// Pixels the document may still decode: the budget less what its cached
    /// pictures hold. Stores run one at a time, so none is unaccounted for.
    fn budget_left(&self) -> u64 {
        PIXEL_BUDGET.saturating_sub(self.pixels.values().sum())
    }
    /// The next picture to fetch: none while one is still being stored.
    fn next_asset(&self) -> Option<&str> {
        if !self.storing.is_empty() {
            return None;
        }
        self.wanted
            .iter()
            .find(|src| !self.assets.contains_key(*src))
            .map(String::as_str)
    }
    /// Takes a render if it is the latest asked for. True when it was.
    fn take_render(
        &mut self,
        ticket: u64,
        doc: Arc<bezel_markdown::Doc>,
        wanted: Vec<String>,
    ) -> bool {
        if ticket != self.ticket {
            return false;
        }
        self.rendered = Some(doc);
        self.wanted = wanted;
        if std::mem::take(&mut self.fresh) {
            self.generation += 1;
        }
        true
    }
}

#[cfg(test)]
#[path = "browser_native_local_reader_tests.rs"]
mod tests;
