//! Reader work kept off the native actor thread, which also carries terminal
//! input (#756 review round 1, item 3): decoding and parsing a file, rewriting
//! its images, and admitting and caching an image. One worker thread per
//! window, jobs in order; the actor only sends a job and later takes its result.
use super::policy::{self, Asset};
use bezel_markdown::Doc;
use herdr_client::tmux_daemon::ImageMime;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, mpsc},
};

/// Decoded pixels one document's pictures may hold in total (256 MiB RGBA):
/// at most four pictures at the largest a single one may be.
pub(in crate::tmux_snapshot) const PIXEL_BUDGET: u64 = 64 * 1024 * 1024;

pub(in crate::tmux_snapshot) enum Job {
    Parse {
        pane: String,
        revision: String,
        bytes: Vec<u8>,
    },
    Render {
        pane: String,
        ticket: u64,
        doc: Arc<Doc>,
        assets: BTreeMap<String, Asset>,
    },
    Store {
        pane: String,
        src: String,
        mime: ImageMime,
        bytes: Vec<u8>,
        cache: PathBuf,
        budget: u64,
    },
}

pub(in crate::tmux_snapshot) enum Done {
    Parsed {
        pane: String,
        revision: String,
        doc: Arc<Doc>,
        lossy: bool,
    },
    Rendered {
        pane: String,
        ticket: u64,
        doc: Arc<Doc>,
        wanted: Vec<String>,
    },
    Stored {
        pane: String,
        src: String,
        asset: Asset,
        pixels: u64,
    },
}

/// The file's text, parsed. Raw HTML stays text (the parser keeps it so).
pub(in crate::tmux_snapshot) fn parse(bytes: &[u8]) -> (Arc<Doc>, bool) {
    let (text, lossy) = policy::decode(bytes);
    (Arc::new(bezel_markdown::parse(&text)), lossy)
}

/// Checks a fetched image, counts it against what is left of the document's
/// pixel budget, and copies it into the cache under its own digest.
pub(in crate::tmux_snapshot) fn store(
    cache: &Path,
    mime: ImageMime,
    bytes: &[u8],
    budget: u64,
) -> (Asset, u64) {
    use gpui::ImageFormat;
    use sha2::Digest as _;
    let (format, extension) = match mime {
        ImageMime::Png => (ImageFormat::Png, "png"),
        ImageMime::Jpeg => (ImageFormat::Jpeg, "jpg"),
        ImageMime::Gif => (ImageFormat::Gif, "gif"),
        ImageMime::Webp => (ImageFormat::Webp, "webp"),
        ImageMime::Svg => (ImageFormat::Svg, "svg"),
    };
    let Some(pixels) =
        crate::tmux_snapshot::browser::fleet::favicon_check::reader_pixels(format, bytes)
    else {
        return (Asset::Refused, 0);
    };
    if pixels > budget {
        return (Asset::TooLarge, 0);
    }
    let digest: String = sha2::Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let path = cache.join(format!("{digest}.{extension}"));
    if path.exists() || std::fs::write(&path, bytes).is_ok() {
        (Asset::Ready(path), pixels)
    } else {
        (Asset::Failed, 0)
    }
}

fn run(job: Job) -> Done {
    match job {
        Job::Parse {
            pane,
            revision,
            bytes,
        } => {
            let (doc, lossy) = parse(&bytes);
            Done::Parsed {
                pane,
                revision,
                doc,
                lossy,
            }
        }
        Job::Render {
            pane,
            ticket,
            doc,
            assets,
        } => {
            let (rendered, wanted) = policy::rewrite(&doc, &assets);
            Done::Rendered {
                pane,
                ticket,
                doc: Arc::new(rendered),
                wanted,
            }
        }
        Job::Store {
            pane,
            src,
            mime,
            bytes,
            cache,
            budget,
        } => {
            let (asset, pixels) = store(&cache, mime, &bytes, budget);
            Done::Stored {
                pane,
                src,
                asset,
                pixels,
            }
        }
    }
}

/// The worker thread. It ends when this is dropped.
pub(in crate::tmux_snapshot) struct Kitchen {
    jobs: mpsc::Sender<Job>,
    done: mpsc::Receiver<Done>,
}
impl Kitchen {
    pub(in crate::tmux_snapshot) fn spawn() -> std::io::Result<Self> {
        let (jobs, inbox) = mpsc::channel::<Job>();
        let (outbox, done) = mpsc::channel();
        std::thread::Builder::new()
            .name("tmux-reader-work".into())
            .spawn(move || {
                for job in inbox {
                    if outbox.send(run(job)).is_err() {
                        break;
                    }
                }
            })?;
        Ok(Self { jobs, done })
    }
    pub(in crate::tmux_snapshot) fn send(&self, job: Job) -> bool {
        self.jobs.send(job).is_ok()
    }
    pub(in crate::tmux_snapshot) fn poll(&self) -> Option<Done> {
        self.done.try_recv().ok()
    }
    /// A kitchen whose work thread is gone: every send fails.
    #[cfg(test)]
    pub(in crate::tmux_snapshot) fn closed() -> Self {
        let (jobs, _) = mpsc::channel();
        let (_, done) = mpsc::channel();
        Self { jobs, done }
    }
}

#[cfg(test)]
#[path = "work_tests.rs"]
mod tests;
