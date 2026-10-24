//! Local leases are read off both the socket and model workers, then re-fenced here.
use super::{Command, Error, Graphics, GraphicsUpdate, Mailbox, PaneStream, publish_graphics};
use crate::tmux_graphics::local::{Job, LocalFrame, LocalImages, ReadEvent, Reader};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Instant,
};
pub(super) struct LocalTransfers {
    root: LocalImages,
    reader: Reader,
    pending: BTreeMap<String, Arc<Job>>,
}
impl LocalTransfers {
    pub fn new(root: LocalImages) -> Result<Self, Error> {
        if !root.validate() {
            return Err(Error::Graphics(crate::tmux_graphics::Error::Identity));
        }
        let reader = Reader::spawn(root.clone()).map_err(Error::Spawn)?;
        Ok(Self {
            root,
            reader,
            pending: BTreeMap::new(),
        })
    }
    pub fn events(&self) -> crossbeam_channel::Receiver<ReadEvent> {
        self.reader.events.clone()
    }
    pub fn accept(
        &mut self,
        raw: &str,
        graphics: &mut Graphics,
        stream: &PaneStream,
        shared: &Mutex<Mailbox>,
    ) -> Result<(), Error> {
        let frame = LocalFrame::parse(raw, &self.root)?;
        // A duplicate lease is released; the already dispatched transfer retains ownership.
        if self.pending.contains_key(&frame.lease_id) {
            return Err(Error::Graphics(crate::tmux_graphics::Error::Ordering));
        }
        let Some(job) = graphics.local_job(frame.clone())? else {
            return release_frame(stream, &frame);
        };
        if self.pending.values().any(|old| {
            old.frame.pane == job.frame.pane && old.frame.blob.digest == job.frame.blob.digest
        }) {
            return release(stream, &job);
        }
        if self.pending.len() >= 8 || !job.frame.fresh() || !self.reader.submit(Arc::clone(&job)) {
            return finish(graphics, stream, shared, &job, true);
        }
        self.pending.insert(job.frame.lease_id.clone(), job);
        Ok(())
    }
    pub fn apply(
        &mut self,
        event: ReadEvent,
        graphics: &mut Graphics,
        stream: &PaneStream,
        shared: &Mutex<Mailbox>,
    ) -> Result<(), Error> {
        match event {
            ReadEvent::Chunk {
                job,
                offset,
                bytes,
                complete,
            } => {
                if self
                    .pending
                    .get(&job.frame.lease_id)
                    .is_none_or(|pending| !Arc::ptr_eq(pending, &job))
                {
                    return Ok(());
                }
                if let Some(update) = graphics.local_chunk(&job, offset, bytes, Instant::now())? {
                    publish_graphics(shared, stream, update)?;
                    if complete {
                        self.pending.remove(&job.frame.lease_id);
                        finish(graphics, stream, shared, &job, false)?;
                    }
                } else {
                    self.pending.remove(&job.frame.lease_id);
                    finish(graphics, stream, shared, &job, true)?;
                }
            }
            ReadEvent::Failed(job) => {
                if self.pending.remove(&job.frame.lease_id).is_some() {
                    finish(graphics, stream, shared, &job, true)?;
                }
            }
        }
        Ok(())
    }
}
fn send(stream: &PaneStream, value: serde_json::Value) -> Result<(), Error> {
    stream.try_send(Command::from_json(
        serde_json::to_string(&value).map_err(Error::Ack)?,
    )?)?;
    Ok(())
}
fn release_frame(stream: &PaneStream, frame: &LocalFrame) -> Result<(), Error> {
    send(
        stream,
        serde_json::json!({"type":"terminal-graphics-local-release","pane":frame.pane,"generation":frame.generation,"leaseId":frame.lease_id}),
    )
}
fn release(stream: &PaneStream, job: &Job) -> Result<(), Error> {
    release_frame(stream, &job.frame)
}
fn finish(
    graphics: &mut Graphics,
    stream: &PaneStream,
    shared: &Mutex<Mailbox>,
    job: &Job,
    fallback: bool,
) -> Result<(), Error> {
    job.cancelled
        .store(true, std::sync::atomic::Ordering::Release);
    release(stream, job)?;
    if !fallback {
        return Ok(());
    }
    let current = graphics.local_current(job);
    if current {
        graphics.local_retry(job, Instant::now());
        publish_graphics(
            shared,
            stream,
            GraphicsUpdate {
                invalidated: vec![job.frame.blob.digest.clone()],
                ..Default::default()
            },
        )?;
        send(
            stream,
            serde_json::json!({"type":"terminal-graphics-request","pane":job.frame.pane,"digests":[job.frame.blob.digest],"preferInline":true}),
        )?;
    } else if graphics.local_discard(job) {
        publish_graphics(
            shared,
            stream,
            GraphicsUpdate {
                invalidated: vec![job.frame.blob.digest.clone()],
                ..Default::default()
            },
        )?;
    }
    Ok(())
}
