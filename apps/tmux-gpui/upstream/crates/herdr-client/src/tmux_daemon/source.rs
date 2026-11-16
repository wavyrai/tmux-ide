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
/// One machine's route, shared by every source of the same machine.
#[cfg(unix)]
type RouteSlot = std::sync::Mutex<Option<crate::tmux_ssh::RemoteTransport>>;
#[cfg(unix)]
type SharedRoute = Arc<RouteSlot>;
/// A machine: its SSH target and the environment it must prove.
#[cfg(unix)]
type MachineKey = (String, Option<String>);
/// The routes of the sources that exist, by machine. The app opened a source
/// per window, picker and fleet row, and each opened its own SSH forward to the
/// same machine; a healthy route is now shared, so one machine has one
/// forward. Held weakly: the route ends with the last source of its machine.
#[cfg(unix)]
static ROUTES: std::sync::Mutex<Vec<(MachineKey, std::sync::Weak<RouteSlot>)>> =
    std::sync::Mutex::new(Vec::new());
#[cfg(unix)]
fn shared_route(
    target: &crate::tmux_ssh::SshTarget,
    expected_environment: Option<&str>,
) -> SharedRoute {
    let key = (
        target.as_str().to_owned(),
        expected_environment.map(str::to_owned),
    );
    let Ok(mut routes) = ROUTES.lock() else {
        return Arc::default();
    };
    routes.retain(|(_, route)| route.strong_count() > 0);
    if let Some(route) = routes
        .iter()
        .find(|(known, _)| *known == key)
        .and_then(|(_, route)| route.upgrade())
    {
        return route;
    }
    let route = SharedRoute::default();
    routes.push((key, Arc::downgrade(&route)));
    route
}
#[cfg(unix)]
pub struct RemoteSource {
    target: crate::tmux_ssh::SshTarget,
    expected_environment: Option<String>,
    route: SharedRoute,
    opening: std::sync::Mutex<Option<Arc<AtomicBool>>>,
    stopped: AtomicBool,
}
impl CatalogSource {
    #[cfg(unix)]
    pub fn remote(
        target: crate::tmux_ssh::SshTarget,
        expected_environment: Option<String>,
    ) -> Self {
        let route = shared_route(&target, expected_environment.as_deref());
        Self::Remote(Arc::new(RemoteSource {
            target,
            expected_environment,
            route,
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
            // Other sources of the machine share it: a reset is ordinary
            // navigation (Home, refresh), so a route that still works stays
            // for them; only a failed one is replaced (review of 18c558c5).
            if Arc::strong_count(&source.route) > 1
                && cached.as_ref().is_some_and(|route| route.healthy())
            {
                return Ok(());
            }
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
            // Another source of the same machine still uses the route: it ends
            // with the last one (or with the app, through the forward's guard).
            if Arc::strong_count(&source.route) > 1 {
                return Ok(());
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
