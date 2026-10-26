use super::{Error, LocalDaemon, owner::Owner};
#[cfg(unix)]
use std::sync::atomic::Ordering;
use std::{
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
};
#[derive(Clone)]
pub enum CatalogSource {
    Local(PathBuf),
    #[cfg(unix)]
    Remote(Arc<RemoteSource>),
}
#[cfg(unix)]
pub struct RemoteSource {
    target: crate::tmux_ssh::SshTarget,
    expected_environment: Option<String>,
    route: std::sync::Mutex<Option<crate::tmux_ssh::RemoteTransport>>,
    opening: std::sync::Mutex<Option<Arc<AtomicBool>>>,
    stopped: AtomicBool,
}
impl CatalogSource {
    #[cfg(unix)]
    pub fn remote(
        target: crate::tmux_ssh::SshTarget,
        expected_environment: Option<String>,
    ) -> Self {
        Self::Remote(Arc::new(RemoteSource {
            target,
            expected_environment,
            route: std::sync::Mutex::new(None),
            opening: std::sync::Mutex::new(None),
            stopped: AtomicBool::new(false),
        }))
    }
    pub(super) fn discover(&self, cancelled: &Arc<AtomicBool>) -> Result<Owner, Error> {
        match self {
            Self::Local(record) => {
                let _ = cancelled;
                Ok(Owner::Local(Arc::new(LocalDaemon::discover(record)?)))
            }
            #[cfg(unix)]
            Self::Remote(source) => source.discover(cancelled),
        }
    }
    pub(super) fn reset(&self, current: Option<&Owner>) -> Result<(), Error> {
        #[cfg(unix)]
        if let (Self::Remote(source), Some(Owner::Remote(current))) = (self, current)
            && let Ok(mut cached) = source.route.lock()
            && cached
                .as_ref()
                .is_some_and(|route| route.generation() == current.generation())
        {
            // Both foreground and layout workers reset. Only the worker holding
            // this generation can invalidate it, never a replacement route.
            if let Some(route) = cached.as_ref() {
                route.shutdown_owned().map_err(super::owner::remote_error)?;
            }
            cached.take();
        }
        #[cfg(not(unix))]
        let _ = current;
        Ok(())
    }
    /// Shutdown boundary after the app event loop, never an active UI callback.
    /// Stops owned forwarding only; local and remote daemons remain untouched.
    pub fn shutdown(&self) -> Result<(), Error> {
        #[cfg(unix)]
        if let Self::Remote(source) = self {
            source.stopped.store(true, Ordering::Release);
            if let Some(opening) = source.opening.lock().map_err(|_| Error::Retired)?.as_ref() {
                opening.store(true, Ordering::Release);
            }
            let mut cached = source.route.lock().map_err(|_| Error::Retired)?;
            if let Some(route) = cached.as_ref() {
                route.shutdown_owned().map_err(super::owner::remote_error)?;
            }
            cached.take();
        }
        Ok(())
    }
}
#[cfg(unix)]
impl RemoteSource {
    fn discover(&self, cancelled: &Arc<AtomicBool>) -> Result<Owner, Error> {
        use std::{
            sync::TryLockError,
            time::{Duration, Instant},
        };
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut cached = loop {
            if cancelled.load(Ordering::Acquire) || self.stopped.load(Ordering::Acquire) {
                return Err(Error::Retired);
            }
            if Instant::now() >= deadline {
                return Err(super::owner::remote_error(
                    crate::tmux_ssh::TransportError::Timeout,
                ));
            }
            match self.route.try_lock() {
                Ok(cached) => break cached,
                Err(TryLockError::Poisoned(_)) => return Err(Error::Retired),
                Err(TryLockError::WouldBlock) => std::thread::sleep(Duration::from_millis(5)),
            }
        };
        let created = cached.is_none();
        if created {
            {
                let mut opening = self.opening.lock().map_err(|_| Error::Retired)?;
                if self.stopped.load(Ordering::Acquire) {
                    return Err(Error::Retired);
                }
                *opening = Some(cancelled.clone());
            }
            let result = crate::tmux_ssh::RemoteTransport::connect(
                &self.target,
                self.expected_environment.as_deref(),
                cancelled,
                deadline,
            );
            self.opening.lock().map_err(|_| Error::Retired)?.take();
            *cached = Some(result.map_err(super::owner::remote_error)?);
        }
        if cancelled.load(Ordering::Acquire) || self.stopped.load(Ordering::Acquire) {
            if created {
                if let Some(route) = cached.as_ref() {
                    route.shutdown_owned().map_err(super::owner::remote_error)?;
                }
                cached.take();
            }
            return Err(Error::Retired);
        }
        let route = cached
            .as_ref()
            .ok_or(Error::Retired)?
            .fork()
            .map_err(super::owner::remote_error)?;
        Ok(Owner::Remote(Arc::new(route)))
    }
}

#[cfg(all(test, unix))]
#[path = "source_tests.rs"]
mod tests;
