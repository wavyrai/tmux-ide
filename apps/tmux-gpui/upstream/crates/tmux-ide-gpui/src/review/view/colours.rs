//! Colours for the diff, worked out only for what comes into view. Drawing
//! a line asks for its stretch of its hunk; the asks are coloured
//! together on the background executor, syntax and changed words both, and
//! kept in a cache that forgets the least recently drawn past a bound. A
//! line not coloured yet draws plain until its colours land.
use crate::{
    HerdrWindow,
    browser::TabId,
    review::{
        diff::{Lines, emphasis},
        highlight::{self, Span},
    },
};
use gpui::Context;
use std::{
    cell::Cell,
    collections::{HashMap, HashSet},
    ops::Range,
    sync::Arc,
};

/// Lines whose colours are kept at most.
const MAX_COLOURED_LINES: usize = 60_000;
/// Stretches coloured per background job.
const BATCH: usize = 32;
/// Stretches waiting at most: scrolling fast past thousands only colours
/// the ones it stopped on.
const MAX_WANTED: usize = 256;

/// One stretch's colours, by line from `start`.
struct Coloured {
    start: usize,
    spans: Vec<Vec<Span>>,
    emphasis: Vec<Vec<Range<u32>>>,
    /// When it was last drawn, to forget the oldest first.
    used: Cell<u64>,
}

/// A stretch to colour: its file and first line.
type Key = (usize, usize);

#[derive(Default)]
pub(super) struct Colours {
    done: HashMap<Key, Coloured>,
    /// Asked for and not coloured yet; `wanted` holds the ones not sent.
    pending: HashSet<Key>,
    wanted: Vec<Key>,
    /// A job is out or about to be.
    busy: bool,
    clock: Cell<u64>,
    held: usize,
}

impl Colours {
    /// The spans and changed words of line `line` of `file`, in the
    /// stretch starting at `start`, once coloured.
    pub(super) fn line(
        &self,
        file: usize,
        start: usize,
        line: usize,
    ) -> Option<(&[Span], &[Range<u32>])> {
        let coloured = self.done.get(&(file, start))?;
        let tick = self.clock.get() + 1;
        self.clock.set(tick);
        coloured.used.set(tick);
        let index = line.checked_sub(coloured.start)?;
        Some((
            coloured.spans.get(index).map_or(&[][..], Vec::as_slice),
            coloured.emphasis.get(index).map_or(&[][..], Vec::as_slice),
        ))
    }

    /// Asks for a stretch; whether it is newly asked.
    fn want(&mut self, key: Key) -> bool {
        if self.done.contains_key(&key) || !self.pending.insert(key) {
            return false;
        }
        self.wanted.push(key);
        if self.wanted.len() > MAX_WANTED {
            let stale = self.wanted.remove(0);
            self.pending.remove(&stale);
        }
        true
    }

    /// Drops what is known of `file`, whose lines changed.
    pub(super) fn forget(&mut self, file: usize) {
        self.done.retain(|(owner, _), coloured| {
            let keep = *owner != file;
            if !keep {
                self.held -= coloured.spans.len();
            }
            keep
        });
        self.pending.retain(|(owner, _)| *owner != file);
        self.wanted.retain(|(owner, _)| *owner != file);
    }

    fn insert(&mut self, key: Key, coloured: Coloured) {
        self.held += coloured.spans.len();
        if let Some(old) = self.done.insert(key, coloured) {
            self.held -= old.spans.len();
        }
        while self.held > MAX_COLOURED_LINES && self.done.len() > 1 {
            let Some(oldest) = self
                .done
                .iter()
                .filter(|(other, _)| **other != key)
                .min_by_key(|(_, coloured)| coloured.used.get())
                .map(|(key, _)| *key)
            else {
                break;
            };
            if let Some(gone) = self.done.remove(&oldest) {
                self.held -= gone.spans.len();
            }
        }
    }
}

/// A stretch sent to be coloured, with the lines it was cut from.
struct Job {
    key: Key,
    name: String,
    lines: Arc<Lines>,
}

impl HerdrWindow {
    /// Asks for line `line` of `file` to be coloured, if it is not.
    pub(super) fn want_review_colours(
        &mut self,
        id: TabId,
        file: usize,
        line: usize,
        cx: &mut Context<Self>,
    ) {
        let Some(review) = self.reviews.get_mut(&id) else {
            return;
        };
        let Some(start) = review
            .loaded()
            .and_then(|loaded| loaded.diff.files.get(file))
            .and_then(|entry| entry.lines())
            .map(|lines| lines.stretch(line).start)
        else {
            return;
        };
        if review.colours.want((file, start)) && !review.colours.busy {
            review.colours.busy = true;
            // After this frame, so the rows it draws all ask first.
            cx.spawn(async move |this, cx| {
                this.update(cx, |this, cx| this.colour_review(id, cx)).ok();
            })
            .detach();
        }
    }

    /// Colours the next stretches asked for, newest first: the ones in view.
    fn colour_review(&mut self, id: TabId, cx: &mut Context<Self>) {
        let Some(review) = self.reviews.get_mut(&id) else {
            return;
        };
        let colours = &mut review.colours;
        let take = colours.wanted.len().min(BATCH);
        let keys: Vec<Key> = colours
            .wanted
            .drain(colours.wanted.len() - take..)
            .rev()
            .collect();
        let jobs: Vec<Job> = keys
            .into_iter()
            .filter_map(|key| {
                let entry = review.loaded()?.diff.files.get(key.0)?;
                Some(Job {
                    key,
                    name: entry.path.clone(),
                    lines: entry.lines()?.clone(),
                })
            })
            .collect();
        if jobs.is_empty() {
            review.colours.busy = false;
            return;
        }
        let colouring = cx.background_executor().spawn(async move {
            jobs.into_iter()
                .map(|job| {
                    let range = job.lines.stretch(job.key.1);
                    let spans = highlight::colour(&job.name, &job.lines, range.clone());
                    let words = emphasis(&job.lines, range.clone());
                    (job, range.start, spans, words)
                })
                .collect::<Vec<_>>()
        });
        cx.spawn(async move |this, cx| {
            let coloured = colouring.await;
            this.update(cx, |this, cx| {
                let Some(review) = this.reviews.get_mut(&id) else {
                    return;
                };
                for (job, start, spans, words) in coloured {
                    review.colours.pending.remove(&job.key);
                    // Lines read again since are coloured again.
                    let current = review
                        .loaded()
                        .and_then(|loaded| loaded.diff.files.get(job.key.0))
                        .and_then(|entry| entry.lines())
                        .is_some_and(|lines| Arc::ptr_eq(lines, &job.lines));
                    if current {
                        review.colours.insert(
                            job.key,
                            Coloured {
                                start,
                                spans,
                                emphasis: words,
                                used: Cell::new(0),
                            },
                        );
                    }
                }
                if review.colours.wanted.is_empty() {
                    review.colours.busy = false;
                } else {
                    this.colour_review(id, cx);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
}
