//! Reading a listed review's lines. One batch is out at a time: files that
//! scrolled into view unread go first, then the rest in order until the
//! background budget is spent, after which a file is read only once it is
//! seen. A file too large to read unasked waits for the user, and hidden
//! lines above a hunk are read on request. Results of an older load, or for
//! lines that changed meanwhile, are dropped.
use crate::{
    HerdrWindow,
    browser::TabId,
    review::diff::{self, Body, EAGER_LINES, Lines, Request, RowId},
};
use gpui::Context;
use std::sync::Arc;

impl HerdrWindow {
    /// Sends the next batch of files to be read, unless one is out.
    pub(super) fn schedule_review_reads(&mut self, id: TabId, cx: &mut Context<Self>) {
        let Some(review) = self.reviews.get_mut(&id) else {
            return;
        };
        if review.batch_out {
            return;
        }
        let Some(loaded) = review.loaded() else {
            return;
        };
        let files = &loaded.diff.files;
        let reading = &review.reading;
        let readable = |index: usize| {
            files.get(index).is_some_and(|file| {
                file.body == Body::Pending && !file.folded && !reading.contains(&index)
            })
        };
        let seen: Vec<(usize, u64)> = review
            .wanted
            .iter()
            .copied()
            .filter(|index| readable(*index))
            .map(|index| (index, files[index].weight()))
            .collect();
        let mut batch = diff::batch(seen);
        let eager = batch.is_empty() && review.eager < EAGER_LINES;
        if eager {
            batch = diff::batch(
                (review.cursor..files.len())
                    .filter(|index| readable(*index))
                    .map(|index| (index, files[index].weight())),
            );
        }
        if batch.is_empty() {
            review.wanted.clear();
            return;
        }
        let requests: Vec<Request> = batch
            .iter()
            .map(|&index| Request::of(index, &files[index]))
            .collect();
        let weight: u64 = batch.iter().map(|&index| files[index].weight()).sum();
        let source = loaded.source.clone();
        let request = review.request;
        if eager && let Some(&last) = batch.last() {
            review.cursor = last + 1;
            review.eager += weight;
        }
        for index in &batch {
            review.wanted.remove(index);
        }
        review.reading.extend(batch);
        review.batch_out = true;
        let reading = cx
            .background_executor()
            .spawn(async move { diff::bodies(&source, &requests, false) });
        cx.spawn(async move |this, cx| {
            let read = reading.await;
            this.update(cx, |this, cx| {
                if let Some(review) = this.reviews.get_mut(&id)
                    && review.request == request
                {
                    review.batch_out = false;
                }
                this.review_bodies_read(id, request, read, cx);
                this.schedule_review_reads(id, cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Asks for `file`'s lines, unread as it scrolled into view.
    pub(super) fn want_review_body(&mut self, id: TabId, file: usize, cx: &mut Context<Self>) {
        let Some(review) = self.reviews.get_mut(&id) else {
            return;
        };
        if review.reading.contains(&file) || !review.wanted.insert(file) || review.batch_out {
            return;
        }
        // After this frame, so every unread file it draws is asked for.
        cx.spawn(async move |this, cx| {
            this.update(cx, |this, cx| this.schedule_review_reads(id, cx))
                .ok();
        })
        .detach();
    }

    /// Reads `file` whatever its size, as the user asked.
    pub(super) fn load_review_file(&mut self, id: TabId, file: usize, cx: &mut Context<Self>) {
        let Some(review) = self.reviews.get_mut(&id) else {
            return;
        };
        let Some(loaded) = review.loaded() else {
            return;
        };
        let Some(entry) = loaded.diff.files.get(file) else {
            return;
        };
        if review.reading.contains(&file) {
            return;
        }
        let requests = [Request::of(file, entry)];
        let source = loaded.source.clone();
        let request = review.request;
        review.reading.insert(file);
        let reading = cx
            .background_executor()
            .spawn(async move { diff::bodies(&source, &requests, true) });
        cx.spawn(async move |this, cx| {
            let read = reading.await;
            this.update(cx, |this, cx| {
                this.review_bodies_read(id, request, read, cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    /// Takes the lines read for load `request`, if it is still the one shown.
    fn review_bodies_read(
        &mut self,
        id: TabId,
        request: u64,
        read: Vec<(usize, Body)>,
        cx: &mut Context<Self>,
    ) {
        let Some(review) = self
            .reviews
            .get_mut(&id)
            .filter(|review| review.request == request)
        else {
            return;
        };
        for (file, body) in read {
            review.reading.remove(&file);
            review.set_body(file, body);
        }
        review.refresh_marks();
        // A reload returns to the line it was on once that file is read.
        if let Some(anchor) = review.restore.clone()
            && let Some(loaded) = review.loaded()
        {
            let paths = loaded.diff.paths();
            if let Some(row) = loaded.diff.row_of(&paths, &anchor) {
                review.restore = None;
                review.scroll_to_row(row);
            } else if paths
                .get(anchor_path(&anchor))
                .and_then(|&file| loaded.diff.files.get(file))
                .is_some_and(|file| file.body != Body::Pending)
            {
                review.restore = None;
            }
        }
        self.rerun_review_search(id, cx);
    }

    /// Reads the unchanged lines hidden above the hunk header at `header`
    /// of `file` and shows them.
    pub(super) fn expand_review_hunk(
        &mut self,
        id: TabId,
        file: usize,
        header: usize,
        cx: &mut Context<Self>,
    ) {
        let Some(review) = self.reviews.get_mut(&id) else {
            return;
        };
        let Some(loaded) = review.loaded() else {
            return;
        };
        let Some(entry) = loaded.diff.files.get(file) else {
            return;
        };
        let (Some(lines), false) = (
            entry.lines().cloned(),
            review.expanding.contains(&(file, header)),
        ) else {
            return;
        };
        let Some(gap) = lines.gap(header) else {
            return;
        };
        let range = gap.next();
        let (checkout, path) = (loaded.source.checkout.clone(), entry.git_path().to_owned());
        let request = review.request;
        review.expanding.insert((file, header));
        let reading = cx.background_executor().spawn({
            let range = range.clone();
            async move { diff::read_lines(&checkout, &path, range) }
        });
        cx.spawn(async move |this, cx| {
            let texts = reading.await;
            this.update(cx, |this, cx| {
                let Some(review) = this
                    .reviews
                    .get_mut(&id)
                    .filter(|review| review.request == request)
                else {
                    return;
                };
                review.expanding.remove(&(file, header));
                let current = review
                    .loaded()
                    .and_then(|loaded| loaded.diff.files.get(file))
                    .and_then(|entry| entry.lines())
                    .is_some_and(|now| Arc::ptr_eq(now, &lines));
                let Some(texts) = texts.filter(|texts| current && !texts.is_empty()) else {
                    cx.notify();
                    return;
                };
                let added = texts.len();
                let grown: Lines =
                    lines.with_context(header, range.start, gap.old(range.start), &texts);
                review.set_body(file, Body::Loaded(Arc::new(grown)));
                // A note being written below the new lines moves down with them.
                if let Some(RowId::Line { file: noted, line }) = review.draft
                    && noted == file
                    && line > header
                {
                    review.draft = Some(RowId::Line {
                        file,
                        line: line + added,
                    });
                }
                review.refresh_marks();
                this.rerun_review_search(id, cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }
}

fn anchor_path(anchor: &diff::Anchor) -> &str {
    let (diff::Anchor::File { path } | diff::Anchor::Line { path, .. }) = anchor;
    path
}
