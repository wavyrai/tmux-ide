//! Reader panes' file and image reads (#756), on their own bounded worker so
//! terminal delivery never waits for them. One request is in flight at a
//! time. A visible reader is polled every 750 ms with the revision it shows;
//! the daemon answers `unchanged` for the cost of one stat. A changed file
//! arrives in 512 KiB pages, is decoded and parsed here, off the UI thread,
//! and is published with its images rewritten to the app's own cache.
use super::*;
use crate::tmux_snapshot::reader::{
    Published, Status,
    policy::{self, Asset},
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

fn page_of(progress: Option<&Progress>) -> Option<ReaderPage> {
    progress.map(|p| ReaderPage {
        revision: p.revision.clone(),
        offset: p.bytes.len() as u64,
    })
}

/// Checks a fetched image and copies it into the cache under its own digest.
fn store(cache: &std::path::Path, mime: ImageMime, bytes: &[u8]) -> Asset {
    use gpui::ImageFormat;
    use sha2::Digest as _;
    let (format, extension) = match mime {
        ImageMime::Png => (ImageFormat::Png, "png"),
        ImageMime::Jpeg => (ImageFormat::Jpeg, "jpg"),
        ImageMime::Gif => (ImageFormat::Gif, "gif"),
        ImageMime::Webp => (ImageFormat::Webp, "webp"),
        ImageMime::Svg => (ImageFormat::Svg, "svg"),
    };
    if !fleet::favicon_check::admissible_reader(format, bytes) {
        return Asset::Refused;
    }
    let digest: String = sha2::Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let path = cache.join(format!("{digest}.{extension}"));
    if path.exists() || std::fs::write(&path, bytes).is_ok() {
        Asset::Ready(path)
    } else {
        Asset::Failed
    }
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
    /// Republishes one pane's reader from what is held.
    fn reader_refresh(&mut self, pane: &str) {
        let Some(fetch) = self.browser_controls.reader.panes.get_mut(pane) else {
            return;
        };
        let doc = fetch.source.as_ref().map(|(_, doc, _)| {
            let (rendered, wanted) = policy::rewrite(doc, &fetch.assets);
            fetch.wanted = wanted;
            Arc::new(rendered)
        });
        let published = Published {
            name: fetch.name.clone(),
            folder: fetch.folder.clone(),
            status: fetch.status.clone(),
            doc,
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
        if changed {
            self.publish()?;
        }
        if self.browser_controls.reader.pending.is_none() {
            self.reader_dispatch()?;
        }
        Ok(())
    }
    fn reader_dispatch(&mut self) -> Result<(), Error> {
        if !self.foreground || self.active.is_none() {
            return Ok(());
        }
        let now = Instant::now();
        let visible: Vec<String> = self
            .browser_controls
            .reader
            .panes
            .keys()
            .filter(|pane| self.state.browser_pane_visible(pane))
            .cloned()
            .collect();
        let gate = &self.browser_controls.reader;
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
                let fetch = &gate.panes[pane];
                let src = fetch
                    .wanted
                    .iter()
                    .find(|src| !fetch.assets.contains_key(*src))?;
                Some((pane.clone(), Job::Asset(src.clone()), None, None))
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
            (job, result) => {
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
                    let old = matches!(
                        result,
                        Err(herdr_client::tmux_daemon::Error::RequestStatus(404))
                    );
                    let status = if old {
                        Status::OldDaemon
                    } else if fetch.failures >= FAILURE_LIMIT {
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
                        let (text, lossy) = policy::decode(&done.bytes);
                        let doc = Arc::new(bezel_markdown::parse(&text));
                        fetch.source = Some((done.revision, doc, lossy));
                        fetch
                            .assets
                            .retain(|_, asset| matches!(asset, Asset::Ready(_)));
                        fetch.generation += 1;
                        fetch.due = Some(now + POLL);
                        changed = true;
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
                    Some(p) if p.bytes.len() as u64 == size => Some(match &gate.cache {
                        Some(cache) => store(cache.path(), mime, &p.bytes),
                        None => Asset::Failed,
                    }),
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

#[cfg(test)]
#[path = "browser_native_local_reader_tests.rs"]
mod tests;
