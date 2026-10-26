//! Optional process-scoped Mach rendezvous. The private system APIs are resolved
//! dynamically; missing support is a fallback condition, never a global-name
//! registration fallback. Lookup yields only a proof endpoint, not pixel access.
use crate::surface_inbox::{Inbox, SendRight, SendStatus};
use anyhow::{Result, ensure};
use mach2::{bootstrap::bootstrap_port, port::mach_port_t};
use std::{
    ffi::CString,
    sync::{
        OnceLock,
        atomic::{AtomicU32, Ordering},
    },
};

// Apple launchd bootstrap_priv.h defines the per-process registration/lookup ABI.
// These are optional implementation details, not a stable public macOS contract.
const PER_PID: u64 = 1;
const UNKNOWN_SERVICE: i32 = 1102;
const SLOTS: u8 = 32;
static OCCUPIED: AtomicU32 = AtomicU32::new(0);
static RETIRING: AtomicU32 = AtomicU32::new(0);
type Register = unsafe extern "C" fn(mach_port_t, *const libc::c_char, mach_port_t, u64) -> i32;
type Lookup = unsafe extern "C" fn(
    mach_port_t,
    *const libc::c_char,
    *mut mach_port_t,
    libc::pid_t,
    u64,
) -> i32;
#[derive(Clone, Copy)]
struct Api {
    register: Register,
    lookup: Lookup,
}
fn api() -> Result<Api> {
    static API: OnceLock<Option<Api>> = OnceLock::new();
    // No maintained safe wrapper exposes these optional Mach bootstrap APIs.
    // SAFETY: resolve the exact C ABI names from the process's system libraries.
    // Missing symbols are never called. System library code remains loaded for
    // the entire process lifetime; pointers are cast only to the declared ABI.
    API.get_or_init(|| unsafe {
        let register = libc::dlsym(libc::RTLD_DEFAULT, c"bootstrap_register2".as_ptr());
        let lookup = libc::dlsym(libc::RTLD_DEFAULT, c"bootstrap_look_up2".as_ptr());
        if register.is_null() || lookup.is_null() {
            return None;
        }
        Some(Api {
            register: std::mem::transmute::<*mut libc::c_void, Register>(register),
            lookup: std::mem::transmute::<*mut libc::c_void, Lookup>(lookup),
        })
    })
    .as_ref()
    .copied()
    .ok_or_else(|| anyhow::anyhow!("process-scoped surface rendezvous unavailable"))
}
struct Slot(u8);
impl Slot {
    fn reserve() -> Result<Self> {
        let old = OCCUPIED
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |bits| {
                (bits != u32::MAX).then(|| bits | (1 << bits.trailing_ones()))
            })
            .map_err(|_| anyhow::anyhow!("native surface rendezvous slots exhausted"))?;
        Ok(Self(old.trailing_ones() as u8))
    }
}
impl Drop for Slot {
    fn drop(&mut self) {
        OCCUPIED.fetch_and(!(1 << self.0), Ordering::AcqRel);
    }
}
fn service_name(slot: u8) -> Result<CString> {
    ensure!(slot < SLOTS, "invalid native rendezvous slot");
    // A finite per-process namespace prevents connection churn from creating an
    // unbounded set of inactive service records. No arbitrary service is looked up.
    Ok(CString::new(format!("org.tmux-ide.surface.v1.{slot}"))?)
}

/// Own on the transport worker. Each process can hold at most 32 registrations.
/// Dropping closes the receive right and lets launchd observe its death;
/// cleanup never waits on a UI/GPU thread or touches another process's names.
pub struct Registration {
    inbox: Option<Inbox>,
    slot: Slot,
    name: CString,
    api: Api,
    registered: bool,
}
impl Registration {
    /// Immediate attempt; a retiring launchd slot falls back without waiting.
    /// Use begin/poll on the transport worker when bounded retry is appropriate.
    pub fn new() -> Result<Self> {
        Self::begin()?
            .poll()?
            .ok_or_else(|| anyhow::anyhow!("native rendezvous slot is retiring"))
    }
    pub fn begin() -> Result<RegistrationAttempt> {
        let api = api()?;
        let slot = Slot::reserve()?;
        let name = service_name(slot.0)?;
        let (inbox, endpoint) = Inbox::new()?;
        Ok(RegistrationAttempt {
            pending: Some(PendingRegistration {
                registration: Self {
                    inbox: Some(inbox),
                    slot,
                    name,
                    api,
                    registered: false,
                },
                endpoint,
                started: std::time::Instant::now(),
            }),
        })
    }
    pub fn slot(&self) -> u8 {
        self.slot.0
    }
    pub fn inbox(&mut self) -> Option<&mut Inbox> {
        self.inbox.as_mut()
    }
}
impl Drop for Registration {
    fn drop(&mut self) {
        if self.registered {
            RETIRING.fetch_or(1 << self.slot.0, Ordering::AcqRel);
        }
        // Destroy the receive right; launchd observes its death. Do not register
        // a null port: on the qualification host that succeeds but leaves a name
        // which rejects replacement as active. The namespace remains finite.
        drop(self.inbox.take());
    }
}

struct PendingRegistration {
    registration: Registration,
    endpoint: SendRight,
    started: std::time::Instant,
}
/// A single bounded slot reservation, polled by the existing transport worker.
/// None means launchd still observes the previous dead receive right as active.
/// No sleeps, queued retries or helper threads are introduced. Drop cancels it.
pub struct RegistrationAttempt {
    pending: Option<PendingRegistration>,
}
impl RegistrationAttempt {
    pub fn poll(&mut self) -> Result<Option<Registration>> {
        let pending = self
            .pending
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("native registration attempt consumed"))?;
        if pending.started.elapsed() >= std::time::Duration::from_secs(5) {
            self.pending.take();
            anyhow::bail!("native registration attempt expired");
        }
        let registration = &pending.registration;
        let bit = 1 << registration.slot.0;
        // SAFETY: bounded NUL-terminated name, live owned endpoint, exact optional
        // C ABI, and PER_PID restrict the operation to this process's reserved slot.
        let status = unsafe {
            (registration.api.register)(
                bootstrap_port,
                registration.name.as_ptr(),
                pending.endpoint.borrowed_name(),
                PER_PID,
            )
        };
        if status == 1103 && RETIRING.load(Ordering::Acquire) & bit != 0 {
            return Ok(None);
        }
        // An unknown active name is a collision, never a cleanup target.
        let mut pending = self
            .pending
            .take()
            .ok_or_else(|| anyhow::anyhow!("native registration attempt consumed"))?;
        ensure!(
            status == 0,
            "native rendezvous slot {} registration status {status}",
            pending.registration.slot.0
        );
        RETIRING.fetch_and(!bit, Ordering::AcqRel);
        pending.registration.registered = true;
        Ok(Some(pending.registration))
    }
}

/// A bootstrap lookup is not receiver authentication. This type can send only a
/// proof reply endpoint, never pixels. Obtain the actual pixel endpoint through
/// Inbox::try_receive_endpoint with an authenticated peer identity and challenge.
pub struct UnverifiedEndpoint(SendRight);
impl UnverifiedEndpoint {
    pub fn try_send_proof(&self, reply: &SendRight, challenge: [u8; 16]) -> Result<SendStatus> {
        self.0.try_send_endpoint(reply, challenge)
    }
}
/// `pid` and `slot` must arrive through authenticated control. Even then, PID
/// reuse requires the full kernel audit proof before sending any pixel storage.
pub fn lookup_unverified(pid: u32, slot: u8) -> Result<Option<UnverifiedEndpoint>> {
    ensure!(
        pid > 0 && pid <= i32::MAX as u32,
        "invalid native rendezvous process"
    );
    let api = api()?;
    let name = service_name(slot)?;
    let mut right = 0;
    // SAFETY: fixed bounded name, initialized output and validated pid. The
    // successful returned reference is transferred into exactly one Rust owner.
    let status = unsafe {
        (api.lookup)(
            bootstrap_port,
            name.as_ptr(),
            &mut right,
            pid as libc::pid_t,
            PER_PID,
        )
    };
    if status == UNKNOWN_SERVICE {
        return Ok(None);
    }
    ensure!(status == 0, "native rendezvous lookup status {status}");
    // An inactive registration can resolve successfully without a live right.
    if right == 0 {
        return Ok(None);
    }
    // SAFETY: a successful lookup returns one owned send-right reference.
    unsafe { SendRight::from_received_right(right).map(|right| Some(UnverifiedEndpoint(right))) }
}

#[cfg(test)]
#[path = "surface_rendezvous_tests.rs"]
mod tests;
