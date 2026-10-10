//! One blocking Coder job on a named thread, reporting through a bounded
//! mailbox that a foreground task drains into its view. Dropping the handle
//! raises the job's cancellation flag and drops the mailbox, so nothing the
//! job sends afterwards reaches the view.

use gpui::{Context, Task};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::Duration,
};

const MAILBOX: usize = 16;
const DRAIN: Duration = Duration::from_millis(100);

pub(crate) struct Worker {
    cancel: Arc<AtomicBool>,
    _task: Task<()>,
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Release);
    }
}

/// Run `work` off the UI thread. It receives a cancellation check and a
/// sender; `apply` receives each message on the UI thread, in order. The
/// sender blocks only while the mailbox is full and the view is still alive.
pub(crate) fn spawn<V: 'static, U: Send + 'static>(
    name: &str,
    cx: &mut Context<V>,
    work: impl FnOnce(&dyn Fn() -> bool, &dyn Fn(U)) + Send + 'static,
    apply: impl Fn(&mut V, U, &mut Context<V>) + 'static,
) -> std::io::Result<Worker> {
    let cancel = Arc::new(AtomicBool::new(false));
    let flag = cancel.clone();
    let (tx, rx) = mpsc::sync_channel(MAILBOX);
    std::thread::Builder::new()
        .name(name.into())
        .spawn(move || {
            let cancelled = || flag.load(Ordering::Acquire);
            let send = |update: U| {
                let _ = tx.send(update);
            };
            work(&cancelled, &send);
        })?;
    let task = cx.spawn(async move |this, cx| {
        loop {
            cx.background_executor().timer(DRAIN).await;
            let mut updates = Vec::new();
            let closed = loop {
                match rx.try_recv() {
                    Ok(update) => updates.push(update),
                    Err(mpsc::TryRecvError::Empty) => break false,
                    Err(mpsc::TryRecvError::Disconnected) => break true,
                }
            };
            let alive = this.update(cx, |this, cx| {
                for update in updates {
                    apply(this, update, cx);
                }
                cx.notify();
            });
            if closed || alive.is_err() {
                return;
            }
        }
    });
    Ok(Worker {
        cancel,
        _task: task,
    })
}
